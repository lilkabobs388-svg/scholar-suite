exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body);

    // Respect what the client asks for, but clamp to a safe range for Groq's free tier
    // (roughly 6,000-12,000 tokens/minute combined input+output for this model).
    const requested = Number(body.max_tokens) || 1200;
    const maxTokens = Math.min(Math.max(requested, 256), 2000);

    const groqBody = {
      model: "llama-3.3-70b-versatile",
      max_tokens: maxTokens,
      messages: [
        ...(body.system ? [{ role: "system", content: body.system }] : []),
        ...body.messages,
      ],
    };

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(groqBody),
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || `Groq API error (status ${response.status})`;
      return {
        statusCode: 200, // keep 200 so the client's JSON parsing doesn't choke — error is in the body
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: [{ type: "text", text: "" }], error: errMsg }),
      };
    }

    const text = data.choices?.[0]?.message?.content || "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: [{ type: "text", text }] }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: [{ type: "text", text: "" }], error: err.message }),
    };
  }
};
