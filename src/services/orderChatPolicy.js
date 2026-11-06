const workerChatStatuses = new Set(["in_progress", "completed", "waiting_user"]);

function orderChatDenial(order, userId, isAdmin) {
  if (!order) return "ORDER_NOT_FOUND";
  if (isAdmin) return null;
  if (String(order.userId) !== String(userId)) return "FORBIDDEN";
  return workerChatStatuses.has(order.status) ? null : "CHAT_UNAVAILABLE";
}

module.exports = { orderChatDenial };
