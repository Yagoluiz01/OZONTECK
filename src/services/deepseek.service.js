import OpenAI from "openai";

console.log(
  "[DEEPSEEK]",
  process.env.DEEPSEEK_API_KEY
    ? "CHAVE ENCONTRADA"
    : "CHAVE NÃO ENCONTRADA"
);

export const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});