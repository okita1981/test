export interface Env {
  OPENAI_API_KEY: string;
  SYSTEM_PROMPT: string;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  VECTORIZE_INDEX: string;
}

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const CHAT_MODEL = "gpt-4o-mini";
const EMBED_MODEL = "text-embedding-3-small"; // 1536次元

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ヘルス
    if (url.pathname === "/api/health") {
      return new Response("ok", { status: 200 });
    }

    // ------- RAG 同期（超ミニマム）
    // POST /api/sync
    // body: { docs: [{ id: "2025_kippou", title: "2025年吉方位凶方位", text: "・・・テキスト・・・" }, ...] }
    if (url.pathname === "/api/sync" && req.method === "POST") {
      try {
        const { docs } = await req.json<any>();
        if (!Array.isArray(docs) || docs.length === 0) {
          return json({ error: "no_docs" }, 400);
        }
        // 1) テキストをチャンク化 → 2) 埋め込み → 3) Vectorize upsert
        const chunks: { id: string; title: string; text: string }[] = [];
        for (const d of docs) {
          const baseId = (d.id || crypto.randomUUID()).toString();
          const title = (d.title || "資料");
          const parts = split(d.text || "", 700);
          parts.forEach((p: string, idx: number) => {
            chunks.push({ id: `${baseId}#${idx}`, title, text: p });
          });
        }
        const vectors = await embed(chunks.map(c => c.text), env);
        await upsertVectorize(
          vectors.map((values, i) => ({
            id: chunks[i].id,
            values,
            metadata: { text: chunks[i].text, title: chunks[i].title }
          })),
          env
        );
        return json({ status: "synced", chunks: chunks.length }, 200);
      } catch (e: any) {
        return json({ error: "sync_failed", detail: String(e) }, 500);
      }
    }

    // ------- チャット本体（RAG注入）
    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const { messages = [] } = await req.json<any>();
        const userText = messages.at(-1)?.content ?? "";

        // 類似検索（上位6件、スコアしきい値0.75）
        const ctx = await queryVectorize(userText, env, 6, 0.75);
        const ctxText = ctx.map((m, i) => `【資料${i + 1}：${m.title}】\n${m.text}`).join("\n---\n");
        const citeLine =
          ctx.length > 0 ? "出典：" + ctx.map(m => `［資料：${m.title}］`).join("、") : "出典：該当なし";

        const sys = [
          { role: "system", content: env.SYSTEM_PROMPT },
          { role: "system", content: "次の社内資料を参考に答えてください：\n" + ctxText }
        ];

        const body = { model: CHAT_MODEL, temperature: 0.4, messages: [...sys, ...messages] };
        const r = await fetch(OPENAI_CHAT_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        if (!r.ok) return json({ error: "openai_error", detail: await r.text() }, 500);

        const j = await r.json();
        let reply = j?.choices?.[0]?.message?.content ?? "（応答なし）";
        // 末尾に簡易出典行を付ける
        reply = `${reply}\n\n${citeLine}`;
        return json({ reply }, 200);
      } catch (e: any) {
        return json({ error: "chat_failed", detail: String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------- utils
const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

function split(s: string, size = 700): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + size));
    i += size;
  }
  return out;
}

async function embed(texts: string[], env: Env): Promise<number[][]> {
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts })
  });
  const j = await res.json();
  return (j.data || []).map((d: any) => d.embedding as number[]);
}

async function upsertVectorize(
  items: { id: string; values: number[]; metadata: Record<string, any> }[],
  env: Env
) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/vectorize/indexes/${env.VECTORIZE_INDEX}/upsert`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ vectors: items })
  });
  if (!r.ok) throw new Error(`vectorize_upsert_failed: ${await r.text()}`);
}

async function queryVectorize(
  query: string,
  env: Env,
  topK = 6,
  scoreThreshold = 0.75
): Promise<{ title: string; text: string; score: number }[]> {
  const [qv] = await embed([query], env);
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/vectorize/indexes/${env.VECTORIZE_INDEX}/query`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      topK,
      vector: qv,
      includeMetadata: true
    })
  });
  const j = await r.json();
  const hits = (j.result?.matches || []).map((m: any) => ({
    title: m.metadata?.title || "資料",
    text: m.metadata?.text || "",
    score: m.score ?? 0
  }));
  return hits.filter((h: any) => h.score >= scoreThreshold);
}
