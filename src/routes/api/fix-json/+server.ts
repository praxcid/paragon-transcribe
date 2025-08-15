import { json } from '@sveltejs/kit';
import { jsonrepair } from 'jsonrepair';

export async function POST({ request }) {
	const buffer = await request.text();
	return json({ formattedJSON: JSON.parse(jsonrepair(buffer)) });
}
