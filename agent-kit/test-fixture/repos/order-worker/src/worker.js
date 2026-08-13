const BASE = process.env.ORDERS_URL || 'http://localhost:4000';

async function pollOrders() {
  const res = await fetch(`${BASE}/orders/pending`);
  return res.json();
}

setInterval(pollOrders, 30000);
