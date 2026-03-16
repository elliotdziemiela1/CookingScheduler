import Anthropic from '@anthropic-ai/sdk';
import type { Recipe, Schedule, ScheduleSettings } from '../types';

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

function getApiKey(): string {
  const key = import.meta.env.CLAUDE_KEY_API;
  if (!key || key === 'your-api-key-here') {
    throw new Error('Please set your CLAUDE_KEY_API in the .env file');
  }
  return key;
}

function buildUserMessage(recipes: Recipe[], settings: ScheduleSettings): string {
  const finishDate = new Date(settings.finishTime);
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

I have ${settings.helperCount} ${settings.helperCount === 1 ? 'person' : 'people'} available to cook.

Please fetch each recipe URL, analyze the steps, and create a coordinated cooking schedule. Remember to respond with ONLY the JSON object.`;
}

function parseScheduleResponse(text: string): Schedule {
  // Try to extract JSON from the response (handle markdown code fences)
  let jsonStr = text.trim();

  // Remove markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);

  // Validate required fields
  if (!parsed.steps || !Array.isArray(parsed.steps)) {
    throw new Error('Invalid schedule format: missing steps array');
  }
  if (!parsed.summary || !parsed.startTime) {
    throw new Error('Invalid schedule format: missing summary or startTime');
  }

  return {
    summary: parsed.summary,
    totalPrepTime: parsed.totalPrepTime || 'Unknown',
    startTime: parsed.startTime,
    steps: parsed.steps.map((s: Record<string, string>) => ({
      time: s.time || '',
      endTime: s.endTime || '',
      assignee: s.assignee || 'Chef 1',
      recipe: s.recipe || 'Unknown',
      action: s.action || '',
      notes: s.notes || undefined,
    })),
  };
}

export async function generateSchedule(
  recipes: Recipe[],
  settings: ScheduleSettings,
  onStatus?: (status: string) => void,
): Promise<Schedule> {
  const apiKey = getApiKey();

  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  onStatus?.('Sending recipes to Claude...');

  const hasUrls = recipes.some((r) => !r.manualContent);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: hasUrls
      ? [{ type: 'web_fetch_20260309' as const, name: 'web_fetch', max_uses: 10 }]
      : [],
    messages: [{ role: 'user', content: buildUserMessage(recipes, settings) }],
  });

  onStatus?.('Processing schedule...');

  // Extract text from the response
  const textBlocks = response.content.filter((b) => b.type === 'text');
  if (textBlocks.length === 0) {
    throw new Error('No text response received from Claude');
  }

  const text = textBlocks.map((b) => {
    if (b.type === 'text') return b.text;
    return '';
  }).join('');

  return parseScheduleResponse(text);
}
