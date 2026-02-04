import axios from "axios";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

function formatInventory(results) {
  const grouped = { "Limited shelf life": [], Fridge: [], Freezer: [], Pantry: [] };

  for (const page of results) {
    const title = page.properties.Item?.title?.[0]?.plain_text ?? "";
    const cat = page.properties.Category?.select?.name ?? "Pantry";
    const note = page.properties.Note?.rich_text?.[0]?.plain_text ?? "";
    const uid = page.properties.ID?.unique_id;

    // Notion Unique ID heeft prefix + number (prefix = "I-")
    const id = uid?.prefix && uid?.number ? `${uid.prefix}${uid.number}` : "I-???";

    if (!title) continue;
    const entry = note ? `[${id}] ${title} (${note})` : `[${id}] ${title}`;
    if (grouped[cat]) grouped[cat].push(entry);
  }

  return ["Limited shelf life", "Fridge", "Freezer", "Pantry"]
    .map((c) => `${c}: ${grouped[c].join(", ")}`)
    .join("\n");
}

function extractJsonBlock(text) {
  const match = text.match(/\{[\s\S]*\}\s*$/);
  if (!match) return null;
  return match[0];
}

export default async function handler(req, res) {
  try {
    // Notion “Send webhook” is POST-only :contentReference[oaicite:1]{index=1}
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    // 1) Inventory ophalen
    const inv = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_INVENTORY_ID,
      filter: { property: "In stock", checkbox: { equals: true } }
    });

    const inventoryText = formatInventory(inv.results);
    if (!inventoryText || inventoryText.includes(": ")) {
      // zelfs leeg kan ": " bevatten, check op items:
      const hasAny = inv.results.length > 0;
      if (!hasAny) {
        return res.status(400).json({ success: false, message: "No items in stock." });
      }
    }

    // 2) Prompt (exact content zoals jij wilde)
    const prompt = `${process.env.PROMPT_TEMPLATE}\n\nInventory data:\n\n${inventoryText}`;

    // 3) LLM call (Chat Completions)
    const llm = await axios.post(
      process.env.API_URL,
      {
        model: process.env.MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 800
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const aiText = llm.data?.choices?.[0]?.message?.content ?? "";
    const lines = aiText.split("\n").map(l => l.trim()).filter(Boolean);

    const dateLine = lines[0] ?? "";
    const bullets = lines.filter(l => l.startsWith("•") || l.startsWith("-") || l.startsWith("*")).slice(0, 3)
      .map(l => l.replace(/^([•\-\*])\s*/, ""));
    const encouragement = lines.find(l => !l.startsWith("•") && !l.startsWith("-") && !l.startsWith("*") && !l.startsWith("{") && l !== dateLine) ?? "";

    // 4) JSON valideren
    const rawJson = extractJsonBlock(aiText);
    if (!rawJson) throw new Error("No JSON block found at end of response.");

    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error("Invalid JSON (parse failed).");
    }
    if (!parsed.meals || !Array.isArray(parsed.meals)) throw new Error("JSON missing meals array.");

    // 5) Write to AI_DATA
    const runTitle = `Run – ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_AIDATA_ID },
      properties: {
        "Run": { title: [{ text: { content: runTitle } }] },
        "Date line": { rich_text: [{ text: { content: dateLine } }] },
        "Meal 1": { rich_text: [{ text: { content: bullets[0] ?? "" } }] },
        "Meal 2": { rich_text: [{ text: { content: bullets[1] ?? "" } }] },
        "Meal 3": { rich_text: [{ text: { content: bullets[2] ?? "" } }] },
        "Encouragement": { rich_text: [{ text: { content: encouragement } }] },
        "Raw JSON": { rich_text: [{ text: { content: rawJson.slice(0, 2000) } }] },
        "Status": { select: { name: "OK" } }
      }
    });

    return res.status(200).json({ success: true, dateLine, meals: bullets });
  } catch (e) {
    // Error log + write ERROR run (zonder “laatste OK” te overschrijven)
    try {
      const runTitle = `Run – ${new Date().toISOString().slice(0, 16).replace("T", " ")} [ERROR]`;
      await notion.pages.create({
        parent: { database_id: process.env.NOTION_DATABASE_AIDATA_ID },
        properties: {
          "Run": { title: [{ text: { content: runTitle } }] },
          "Status": { select: { name: "ERROR" } },
          "Encouragement": { rich_text: [{ text: { content: `Oops — ${e.message}` } }] }
        }
      });
    } catch {}
    return res.status(500).json({ success: false, error: e.message });
  }
}
