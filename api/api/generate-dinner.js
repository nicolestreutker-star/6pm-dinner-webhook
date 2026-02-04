import { Client } from "@notionhq/client";
const notion = new Client({ auth: process.env.NOTION_API_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    // Notion button kan geen mooie body meegeven; dus pakken we meal_id uit querystring
    const meal_id = req.query.meal_id; // M1/M2/M3
    if (!["M1", "M2", "M3"].includes(meal_id)) {
      return res.status(400).json({ success: false, message: "meal_id must be M1, M2, or M3" });
    }

    // 1) laatste AI_DATA run pakken
    const latest = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_AIDATA_ID,
      sorts: [{ property: "Created time", direction: "descending" }],
      page_size: 1
    });
    if (!latest.results.length) return res.status(400).json({ success: false, message: "No AI run found. Generate dinner first." });

    const raw = latest.results[0].properties["Raw JSON"]?.rich_text?.[0]?.plain_text ?? "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return res.status(400).json({ success: false, message: "AI JSON invalid. Generate again." }); }

    const selected = (parsed.meals ?? []).find(m => m.id === meal_id);
    if (!selected) return res.status(400).json({ success: false, message: `Meal ${meal_id} not found in latest run.` });

    const idsToUse = selected.items ?? [];
    if (!idsToUse.length) return res.status(400).json({ success: false, message: "No items for this meal." });

    // 2) Inventory query (alleen in-stock true is genoeg)
    const inv = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_INVENTORY_ID,
      filter: { property: "In stock", checkbox: { equals: true } }
    });

    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;

    for (const page of inv.results) {
      const uid = page.properties.ID?.unique_id;
      const id = uid?.prefix && uid?.number ? `${uid.prefix}${uid.number}` : null;

      if (id && idsToUse.includes(id)) {
        await notion.pages.update({
          page_id: page.id,
          properties: {
            "In stock": { checkbox: false },
            "Last used": { date: { start: today } }
          }
        });
        updated++;
      }
    }

    return res.status(200).json({
      success: true,
      message: `Cooked ${meal_id}. Marked ${updated} items as used.`,
      meal: selected.title,
      used: idsToUse
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
