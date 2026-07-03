const conversations = new Map();

export function getConversation(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }

  return conversations.get(userId);
}

export function addMessage(userId, role, content) {
  const history = getConversation(userId);

  history.push({
    role,
    content,
    createdAt: new Date(),
  });

  if (history.length > 20) {
    history.shift();
  }

  return history;
}