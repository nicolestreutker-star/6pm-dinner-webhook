export default async function handler(req, res) {
  res.status(200).json({ status: "ok", message: "6PM Dinner Decider running" });
}
