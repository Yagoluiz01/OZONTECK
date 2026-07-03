export function logAiRequest({
  userId,
  message,
  duration,
}) {
  console.log("================================");

  console.log("AI REQUEST");

  console.log("Usuário:", userId);

  console.log("Tempo:", duration + "ms");

  console.log("Pergunta:", message);

  console.log("================================");
}