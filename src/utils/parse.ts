import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from 'joplin-turndown-plugin-gfm';

export const cleanHtml = (html: string): string => {
  const $ = cheerio.load(html);

  // Remove unwanted elements
  $("script, style, iframe, noscript, meta, head, footer, nav, aside").remove();

  // Remove comments
  $("*").contents().filter(function () {
    return this.type === 'comment';
  }).remove();

  // Remove empty elements
  $("*").filter(function () {
    return $(this).text().trim() === '' && $(this).children().length === 0;
  }).remove();

  // Remove elements with common ad-related class names or IDs
  $("[class*='ad-'], [class*='advertisement'], [class*='banner'], [id*='ad-'], [id*='advertisement'], [id*='banner']").remove();

  // Remove hidden elements
  $("[style*='display:none'], [style*='visibility:hidden']").remove();

  // Keep only the main content
  const mainContent = $("main, #main, .main, article, .article, .content, #content, .post, #post").first();

  if (mainContent.length > 0) {
    // If a main content area is found, use it
    return mainContent.html() || "";
  } else {
    // If no main content area is found, return the cleaned body
    return $("body").html() || "";
  }
};
interface TurndownNode {
  nodeName: string;
  getAttribute: (attr: string) => string | null;
  title?: string;
}

interface TurndownOptions {
  linkStyle: string;
}

export function parseMarkdown(dirty: string): string {
  const html = cleanHtml(dirty)
  const turndownService = new TurndownService();
  turndownService.addRule("inlineLink", {
    filter: function (node: TurndownNode, options: TurndownOptions) {
      return (
        options.linkStyle === "inlined" &&
        node.nodeName === "A" &&
        node.getAttribute("href") !== null
      );
    },
    replacement: function (content: string, node: TurndownNode) {
      const href = node.getAttribute("href")?.trim() || "";
      const title = node.title ? ` "${node.title}"` : "";
      return `[${content.trim()}](${href}${title})\n`;
    },
  });

  turndownService.use(gfm);
  let markdownContent = turndownService.turndown(html);

  // Handle multiple line links
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char === "[") {
      linkOpenCount++;
    } else if (char === "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char === "\n") {
      newMarkdownContent += "\\\n";
    } else {
      newMarkdownContent += char;
    }
  }
  markdownContent = newMarkdownContent;

  // Remove [Skip to Content](#page) and [Skip to content](#skip)
  markdownContent = markdownContent.replace(
    /\[Skip to Content\]\(#[^)]*\)/gi,
    ""
  );
  return markdownContent;
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];

  const urlObject = new URL(baseUrl);
  const origin = urlObject.origin;

  $('a').each((_, element) => {
    const href = $(element).attr('href');
    if (href) {
      if (href.startsWith('http://') || href.startsWith('https://')) {
        links.push(href);
      } else if (href.startsWith('/')) {
        links.push(`${origin}${href}`);
      } else if (!href.startsWith('#') && !href.startsWith('mailto:')) {
        links.push(`${baseUrl}/${href}`);
      }
    }
  });

  return [...new Set(links)];
}




interface SchemaProperty {
  type: string;
  description: string;
  examples?: any[];
}

interface Schema {
  type: string;
  properties?: Record<string, SchemaProperty>;
  items?: Schema;
  description?: string;
  examples?: any[];
}

// export async function parseSchema(json: any, maxExamples: number = 3, endpoint = ''): Promise<Schema> {
//   const schema: Schema = { type: getType(json) };

//   if (schema.type === 'object' && typeof json === 'object') {
//     schema.properties = {};
//     for (const [key, value] of Object.entries(json)) {
//       schema.properties[key] = await parseSchemaProperty(key, value, json, maxExamples, endpoint);
//     }
//   } else if (schema.type === 'array' && Array.isArray(json)) {
//     if (json.length > 0) {
//       schema.items = await parseSchema(json[0], maxExamples, endpoint);
//       schema.description = await generateDescription('array', json, endpoint);
//       schema.examples = json.slice(0, maxExamples);
//     } else {
//       schema.items = { type: 'any' };
//       schema.description = 'An empty array';
//     }
//   } else {
//     schema.examples = [json];
//     schema.description = await generateDescription('value', json, endpoint);
//   }

//   return schema;
// }

// async function parseSchemaProperty(key: string, value: any, parentObject: any, maxExamples: number, endpoint = ''): Promise<SchemaProperty> {
//   const type = getType(value);
//   const property: SchemaProperty = {
//     type,
//     description: await generateDescription(key, value, parentObject, endpoint),
//   };

//   if (type === 'object' && typeof value === 'object') {
//     // No additional handling needed as the description will be generated by the AI
//   } else if (type === 'array' && Array.isArray(value)) {
//     const itemType = value.length > 0 ? getType(value[0]) : 'any';
//     property.examples = value.slice(0, maxExamples);
//   } else {
//     property.examples = [value];
//   }

//   return property;
// }

function getType(value: any): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

// async function generateDescription(key: string, value: any, parentObject?: any, endpoint = ''): Promise<string> {
//   const context = parentObject ? JSON.stringify(parentObject, null, 2) : JSON.stringify(value, null, 2);
//   let prompt = `
// Given the following JSON object:
// ${context}

// Please provide a brief description for the key "${key}" or the value if it's a primitive.
// If it's an array, describe what kind of items it contains.
// If it's an object, mention its purpose and key properties.
// Keep the description concise, about 1-2 sentences.

// Description:`;

//   if (endpoint.length > 0) {
//     prompt = prompt + "\n This json response came from the endpoint: " + endpoint
//   }

//   try {
//     const response = await APIManager.generateLlamaResponse([
//       { role: "system", content: "You are a helpful assistant that generates concise descriptions for JSON schema properties." },
//       { role: "user", content: prompt }
//     ]);
//     return response.trim();
//   } catch (error) {
//     console.error('Error generating description:', error);
//     return `A ${getType(value)} value`;
//   }
// }

function isUsefulByLength(content: string, minLength: number = 100): boolean {
  return content.length >= minLength;
}

function calculateFleschKincaidScore(text: string): number {
  const sentences = text.split(/[.!?]+/).length;
  const words = text.split(/\s+/).length;
  const syllables = text.split(/[aeiou]/i).length - 1;
  return 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
}

function isUsefulByReadability(content: string, minScore: number = 60): boolean {
  return calculateFleschKincaidScore(content) >= minScore;
}

function isUsefulByInfoDensity(content: string, threshold: number = 0.3): boolean {
  const words = content.split(/\s+/);
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  return uniqueWords.size / words.length >= threshold;
}
function hasBasicSentenceStructure(content: string, minWordLength: number = 2, minSpaceRatio: number = 0.02): boolean {
  const words = content.split(/\s+/);
  const totalChars = content.length;
  const spaceCount = content.split(' ').length - 1;
  const spaceRatio = spaceCount / totalChars;

  // Check if there are enough spaces relative to total characters
  if (spaceRatio < minSpaceRatio) {
    return false;
  }

  // Check if at least 50% of "words" have a reasonable length
  const reasonableLengthWords = words.filter(word => word.length >= minWordLength);
  if (reasonableLengthWords.length < words.length * 0.2) {
    return false;
  }

  // Check if the content contains some punctuation (simple check for periods, question marks, or exclamation points)
  if (!/[.!?]/.test(content)) {
    return false;
  }

  return true;
}
function hasNoLongValues(jsonContent: any, maxLength: number = 1000): boolean {
  const checkValue = (value: any): boolean => {
    if (typeof value === 'string') {
      // Check for sequences without spaces longer than maxLength
      const sequences = value.split(' ');
      return sequences.every(seq => seq.length <= maxLength);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.values(value).every(checkValue);
    }
    if (Array.isArray(value)) {
      return value.every(checkValue);
    }
    return true;
  };

  return checkValue(jsonContent);
}
export function isContentUseful(content: string): boolean {
  // Try to parse the content as JSON
  try {
    const jsonContent = JSON.parse(content);
    // If it's valid JSON, check length, info density, and long values
    return hasNoLongValues(jsonContent);
  } catch (e) {
    // If it's not valid JSON, fall back to the original checks plus the new sentence structure check
    return isUsefulByLength(content) && hasNoLongValues(content)
    // isUsefulByReadability(content) &&
    // isUsefulByInfoDensity(content) &&
    // hasNoLongValues(content);
  }
}