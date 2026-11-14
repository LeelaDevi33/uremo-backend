// The old term is labelled "renewed" as soon as a replacement is reserved.
// Its already-paid access continues only through the original paid period.
function canReadRentalAccess(rental, order, userId, now = Date.now()) {
  if (!rental || !order || !userId || !rental.user || !order.userId ||
      String(rental.user) !== String(userId) || String(order.userId) !== String(userId)) {
    return false;
  }
  const linkedOrderId = rental.order?._id || rental.order;
  if (!linkedOrderId || String(linkedOrderId) !== String(order._id)) return false;
  if (order.rentalId && String(order.rentalId._id || order.rentalId) !== String(rental._id)) return false;
  if (rental.cancelledAt || rental.expiredAt || !rental.startDate || !rental.endDate ||
      !(new Date(rental.startDate).getTime() <= now && now < new Date(rental.endDate).getTime())) {
    return false;
  }
  const renewedPaidTerm = rental.status === "renewed" &&
    (rental.activatedAt || rental.statusLog?.some(entry => entry.status === "active"));
  if (rental.status !== "active" && !renewedPaidTerm) return false;
  if (["cancelled", "refunded"].includes(order.status)) return false;

  // Hydrated legacy orders can carry Mongoose's "unpaid" default in memory.
  // Accept historical verification evidence only when no payment status was stored.
  const paymentStatus = order.$isDefault?.("paymentStatus") ? undefined : order.paymentStatus;
  if (paymentStatus != null) return paymentStatus === "paid";
  return Boolean(order.paidAt || order.payment?.verifiedAt);
}

module.exports = { canReadRentalAccess };
