// src/index.ts
import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { TaskCreate } from "./endpoints/taskCreate";
import { TaskDelete } from "./endpoints/taskDelete";
import { TaskFetch } from "./endpoints/taskFetch";
import { TaskList } from "./endpoints/taskList";

import { chat as llmChat } from "./llm";
import { MemoryDO } from "./memory";
import { SummarizeWorkflow } from "./summarize.workflow";

// ---- Bindings Wrangler provides (wrangler.jsonc) ----
type Bindings = {
  AI: Ai;                                   // Workers AI binding
  MEMORY_DO: DurableObjectNamespace;        // Durable Object namespace
  SUMMARIZE_FLOW: any;                      // Workflow binding (use `any` to avoid TS friction)
};

const app = new Hono<{ Bindings: Bindings }>();

// ---- CORS (so the Pages UI on 5173 can call the API) ----
app.use(
        "*",
        cors({
                origin: "*",
                allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
                allowHeaders: ["Content-Type", "Authorization"],
        }),
);

app.options("*", (c) => {
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
        c.header("Access-Control-Max-Age", "86400");
        return c.text("", 204);
});

app.all("*", async (c, next) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  c.header("access-control-allow-headers", "content-type");
  if (c.req.method === "OPTIONS") return c.text("", 204);
  return next();
});

// ---- Health check ----
app.get("/healthz", (c) => c.text("ok"));

// ---- OpenAPI endpoints you already had ----
const openapi = fromHono(app, { docs_url: "/" });
openapi.get("/api/tasks", TaskList);
openapi.post("/api/tasks", TaskCreate);
openapi.get("/api/tasks/:taskSlug", TaskFetch);
openapi.delete("/api/tasks/:taskSlug", TaskDelete);

// ---- AI routes ----

// POST /chat  (LLM + Durable Object memory)
app.post("/chat", async (c) => {
  const { userId, userMsg } = await c.req.json<{ userId: string; userMsg: string }>();

  // pull memory
  const id = c.env.MEMORY_DO.idFromName(userId);
  const stub = c.env.MEMORY_DO.get(id);
  const mem = await stub
    .fetch("https://do/get", { method: "POST", body: JSON.stringify({ op: "get", userId }) })
    .then((r) => r.json() as Promise<{ prof?: unknown; hist?: string[] }>);

  const history = (mem.hist ?? []).join("\n");
  const profile = mem.prof ? `User profile: ${JSON.stringify(mem.prof)}\n` : "";
  const prompt = `${profile}Conversation so far:\n${history}\nUser: ${userMsg}\nAssistant:`;

  // LLM call
  const answer = await llmChat(c.env.AI, prompt);

  // append to memory
  await stub.fetch("https://do/append", {
    method: "POST",
    body: JSON.stringify({ op: "append", userId, item: `User: ${userMsg}\nAssistant: ${answer}` }),
  });

  return c.json({ answer });
});

// POST /summarize  (kick off workflow)
app.post("/summarize", async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  const instance = await c.env.SUMMARIZE_FLOW.create({ url });
  const status = await instance.status();
  return c.json({ id: instance.id, status });
});

// GET /summarize/status?id=...
app.get("/summarize/status", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text("missing id", 400);
  const instance = await c.env.SUMMARIZE_FLOW.get(id);
  const status = await instance.status();
  return c.json(status);
});

// ---- Export the Hono app as the Worker entry ----
export default app;

// ---- Export classes so Wrangler registers them ----
export { MemoryDO, SummarizeWorkflow };
