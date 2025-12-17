import { json } from '@sveltejs/kit';
import { jsonrepair } from 'jsonrepair';

export async function POST({ request }) {
	const buffer = await request.text();

	// Try direct parse first
	try {
		const parsed = JSON.parse(buffer);
		return json({ formattedJSON: parsed });
	} catch (e) {
		// Not directly parseable; attempt jsonrepair
	}

	try {
		const repaired = jsonrepair(buffer);
		const parsed = JSON.parse(repaired);
		return json({ formattedJSON: parsed });
	} catch (e) {
		// Try to extract JSON substring if the payload contains other text (for example an API error message with embedded JSON)
		try {
			const firstBrace = buffer.indexOf('{');
			const lastBrace = buffer.lastIndexOf('}');
			if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
				const sub = buffer.slice(firstBrace, lastBrace + 1);
				const repaired = jsonrepair(sub);
				const parsed = JSON.parse(repaired);
				return json({ formattedJSON: parsed });
			}
		} catch (inner) {
			// fallthrough to error response
		}

		return json({ error: 'Unable to parse or repair JSON input', rawPreview: buffer.slice(0, 500) }, { status: 400 });
	}
}
