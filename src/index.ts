export interface Env {
  OPENAI_API_KEY: string;
  SYSTEM_PROMPT: string;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ヘルスチェック
    if (url.pathname === "/api/health") {
      return new Response("ok", { status: 200 });
    }

    // チャット本体
    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const { messages = [] } = await req.json<any>();
        const sys = [{ role: "system", content: env.SYSTEM_PROMPT }];
        const body = {
          model: MODEL,
          temperature: 0.4,
          messages: [...sys, ...messages],
        };

        const r = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!r.ok) {
          const text = await r.text();
          return json({ error: "openai_error", detail: text }, 500);
        }
        const j = await r.json();
        const reply = j?.choices?.[0]?.message?.content ?? "（応答なし）";
        return json({ reply }, 200);
      } catch (e: any) {
        return json({ error: "bad_request", detail: String(e) }, 400);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json" },
  });
