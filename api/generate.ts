import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const SYSTEM_PROMPT = `You are an expert professional chef and kitchen coordinator. Your job is to create a perfectly timed cooking schedule that coordinates multiple recipes so all dishes are hot and ready at exactly the specified finish time.

For each recipe URL provided, use the web_fetch tool to retrieve the recipe page and extract:
- Recipe name
- Total prep time and cook time
- Individual steps with estimated durations
- Required equipment (oven, stovetop, mixer, etc.)
- Temperature settings

Then create a unified, backwards-planned schedule that:
1. Works backwards from the finish time so all dishes are ready simultaneously
2. Assigns tasks to available helpers (named "Chef 1", "Chef 2", etc.)
3. Accounts for shared equipment conflicts (e.g., if there's only one oven)
4. Identifies passive time (e.g., "let dough rise") where a person is free to do other tasks
5. Maximizes parallel work across helpers
6. Includes brief, clear action descriptions

IMPORTANT: You MUST respond with ONLY a valid JSON object (no markdown, no explanation before or after). Use this exact schema:
{
  "summary": "Brief overview of the meal plan",
  "totalPrepTime": "e.g. 2 hours 15 minutes",
  "startTime": "e.g. 3:45 PM",
  "steps": [
    {
      "time": "e.g. 3:45 PM",
      "endTime": "e.g. 4:00 PM",
      "assignee": "Chef 1",
      "recipe": "Recipe Name",
      "action": "What to do",
      "notes": "Optional tips or warnings"
    }
  ]
}

Sort steps chronologically by time. Use 12-hour time format (e.g., "3:45 PM").`;

interface Recipe {
  id: string;
  url: string;
  title: string;
  manualContent?: string;
}

interface RequestBody {
  recipes: Recipe[];
  finishTime: string;
  helperCount: number;
}

function buildUserMessage(recipes: Recipe[], finishTime: string, helperCount: number): string {
  const finishDate = new Date(finishTime);
  const timeStr = finishDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const dateStr = finishDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const recipeList = recipes
    .map((r, i) => {
      if (r.manualContent) {
        return `${i + 1}. Recipe (provided manually):\n${r.manualContent}`;
      }
      return `${i + 1}. ${r.url}`;
    })
    .join('\n');

  return `I need to prepare the following recipes, all to be ready at exactly ${timeStr} on ${dateStr}:

${recipeList}

I have ${helperCount} ${helperCount === 1 ? 'person' : 'people'} available to cook.

Please fetch each recipe URL, analyze the steps, and create a coordinated cooking schedule. Remember to respond with ONLY the JSON object.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.CLAUDE_KEY_API;
  if (!apiKey) {
    return res.status(500).json({ error: 'CLAUDE_KEY_API environment variable is not set on the server.' });
  }

  const { recipes, finishTime, helperCount } = req.body as RequestBody;

  if (!recipes?.length || !finishTime || !helperCount) {
    return res.status(400).json({ error: 'Missing required fields: recipes, finishTime, helperCount' });
  }

  try {
    const client = new Anthropic({ apiKey });

    const hasUrls = recipes.some((r) => !r.manualContent);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: hasUrls
        ? [{ type: 'web_fetch_20260309' as const, name: 'web_fetch', max_uses: 10 }]
        : [],
      messages: [{ role: 'user', content: buildUserMessage(recipes, finishTime, helperCount) }],
    });

    // Extract text from the response
    const textBlocks = response.content.filter((b) => b.type === 'text');
    if (textBlocks.length === 0) {
      return res.status(500).json({ error: 'No text response received' });
    }

    const text = textBlocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    // Parse JSON from response (handle markdown code fences)
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const schedule = JSON.parse(jsonStr);

    if (!schedule.steps || !Array.isArray(schedule.steps)) {
      return res.status(500).json({ error: 'Invalid schedule format: missing steps array' });
    }

    return res.status(200).json(schedule);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Generate schedule error:', message);
    return res.status(500).json({ error: message });
  }
}
