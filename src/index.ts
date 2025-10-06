export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // --- CORSプリフライト対応 ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);

    // --- OpenAIに中継するルート ---
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const { messages = [] } = await request.json().catch(() => ({ messages: [] }));

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
        }),
      });

      const data = await response.json().catch(() => ({}));
      const reply = data?.choices?.[0]?.message?.content ?? "応答を取得できませんでした。";

      return new Response(JSON.stringify({ reply }), {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      });
    }

    // --- その他のルートはNot found ---
    return new Response("Not found", { status: 404 });
  },
};
