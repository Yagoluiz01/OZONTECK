import { deepseek } from "../../deepseek.service.js";

export async function askDeepSeek({
  message,
  history = [],
  systemPrompt,
}) {
  try {
    const completion = await deepseek.chat.completions.create({
      model: "deepseek-chat",

      temperature: 0.3,

      messages: [
        {
          role: "system",
          content: systemPrompt,
        },

        ...history,

        {
          role: "user",
          content: message,
        },
      ],
    });

    return {
      success: true,
      reply:
        completion?.choices?.[0]?.message?.content ??
        "Sem resposta.",
    };

  } catch (error) {

    console.error("[DeepSeek Provider]", error);

    return {
      success: false,
      reply:
        "Desculpe, ocorreu um erro ao comunicar com a IA.",
      error
    };
  }
}