import axios from "axios";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

function formatInventory(results) {
  const grouped = {
    "Limited shelf life": [],
    Fridge: [],
    Freezer: [],
    Pantry: []
  };

  for (const page of results) {
    const title = page.properties?.Item?.title?.[0]?.plain_text ?? "";
    const category = page.properties?.Category?.select?.name ?? "Pantry";
    const note = page.properties?.Note?.rich_text?.[0]?.plain_text ?? "";
    const uid = page.properties?.ID?.unique_id;

    // Unique ID: prefix "I-" + number (bijv. I-7)
    const id = uid?.prefix && uid?.number ? `${uid.prefix}${uid.number}` : null;

    if (!title || !id) continue;

    const entry = note ? `[${id}] ${title} (${note})` : `[${id}] ${title}`;
    if (grouped[category]) grouped[category].push(entry);
  }

  return ["Limited shelf life", "Fridge", "Freezer", "Pantry"]
    .map((cat) => `${cat}: ${grouped[cat].join(", ")}`)
    .join("\n");
}

function extractJsonBlock(text) {
  // verwacht dat JSON het laatste is in de output
  const match = text.match(/\{[\s\S]*\}\s*$/);
  return match ? match[0] : null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "POST only" });
    }

    // 1) Alleen items die In stock = true
    const inv = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_INVENTORY_ID,
      filter: { property: "In stock", checkbox: { equals: true } }
    });

    if (!inv.results?.length) {
      return res.status(400).json({
        success: false,
        error: "No items in stock",
        message: "Add items to INVENTORY and set In stock = true."
      });
    }

    const inventoryText = formatInventory(inv.results);

    // 2) Prompt = PROMPT_TEMPLATE + inventory data (format exact zoals jij wil)
    const prompt = `${process.env.PROMPT_TEMPLATE}

Inventory data must be formatted cleanly like:

Limited shelf life: [I-003] chicken (open), [I-014] salad bag

Fridge: ...

Freezer: ...

Pantry: ...

Here is my inventory now:

${inventoryText}
`;

    // 3) LLM call (OpenAI Chat Completions)
    const llm = await axios.post(
      process.env.API_URL,
      {
        model: process.env.MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 900
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const aiText = llm.data?.choices?.[0]?.message?.content ?? "";
    const lines = aiText.split("\n").map((l) => l.trim()).filter(Boolean);

    const dateLine = lines[0] ?? "";

    const mealLines = lines
      .filter((l) => l.startsWith("•") || l.startsWith("-") || l.startsWith("*"))
      .slice(0, 3)
      .map((l) => l.replace(/^([•\-\*])\s*/, ""));

    const meal1 = mealLines[0] ?? "";
    const meal2 = mealLines[1] ?? "";
    const meal3 = mealLines[2] ?? "";

    const rawJson = extractJsonBlock(aiText);
    if (!rawJson) {
      throw new Error("AI output missing JSON block at the end.");
    }

    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error("AI output JSON is invalid (parse failed).");
    }

    if (!parsed.meals || !Array.isArray(parsed.meals)) {
      throw new Error("AI output JSON missing meals array.");
    }

    // Encouragement = eerste normale regel (niet date, niet bullet, niet JSON)
    const encouragement =
      lines.find(
        (l) =>
          l !== dateLine &&
          !l.startsWith("•") &&
          !l.startsWith("-") &&
          !l.startsWith("*") &&
          !l.startsWith("{") &&
          !l.startsWith("}")
      ) ?? "";

    // 4) Schrijf nieuwe run naar AI_DATA
    const runTitle = `Run – ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_AIDATA_ID },
      properties: {
        Run: { title: [{ text: { content: runTitle } }] },
        "Date line": { rich_text: [{ text: { content: dateLine } }] },
        "Meal 1": { rich_text: [{ text: { content: meal1 } }] },
        "Meal 2": { rich_text: [{ text: { content: meal2 } }] },
        "Meal 3": { rich_text: [{ text: { content: meal3 } }] },
        Encouragement: { rich_text: [{ text: { content: encouragement } }] },
        "Raw JSON": { rich_text: [{ text: { content: rawJson.slice(0, 2000) } }] },
        Status: { select: { name: "OK" } }
      }
    });

    return res.status(200).json({
      success: true,
      dateLine,
      meals: [meal1, meal2, meal3],
      encouragement
    });
  } catch (e) {
    // Schrijf ERROR run (zonder vorige OK te overschrijven)
    try {
      const runTitle = `Run – ${new Date().toISOString().slice(0, 16).replace("T", " ")} [ERROR]`;
      await notion.pages.create({
        parent: { database_id: process.env.NOTION_DATABASE_AIDATA_ID },
        properties: {
          Run: { title: [{ text: { content: runTitle } }] },
          Status: { select: { name: "ERROR" } },
          Encouragement: { rich_text: [{ text: { content: `Oops — ${e.message}` } }] }
        }
      });
    } catch {}

    return res.status(500).json({ success: false, error: e.message });
  }
}
