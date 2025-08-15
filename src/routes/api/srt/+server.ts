// Helper function to parse "mm:ss" or "hh:mm:ss" string into total seconds (number)
function parseTimeToSeconds(timeString: string) {
	const parts = timeString.split(':').map(Number);

	if (parts.some(isNaN)) {
		console.warn(`Could not parse numbers from timestamp: "${timeString}".`);
		return NaN;
	}

	let seconds = 0;
	if (parts.length === 3) {
		seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
	} else if (parts.length === 2) {
		seconds = parts[0] * 60 + parts[1]; // mm:ss
	} else {
		console.warn(
			`Invalid timestamp format received: "${timeString}". Expected "mm:ss" or "hh:mm:ss".`
		);
		return NaN;
	}
	return seconds;
}

// Helper function to format total seconds (number) into HH:MM:SS,ms string
function formatTime(totalSeconds: number) {
	const date = new Date(0);
	date.setMilliseconds(totalSeconds * 1000);

	const hours = String(date.getUTCHours()).padStart(2, '0');
	const minutes = String(date.getUTCMinutes()).padStart(2, '0');
	const secs = String(date.getUTCSeconds()).padStart(2, '0');
	const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');

	return `${hours}:${minutes}:${secs},${milliseconds}`;
}

export async function POST({ request }) {
	try {
		const { transcript } = await request.json();

		let srtContent = '';
		const defaultDuration = 3; // Default duration in seconds for the last segment

		for (let i = 0; i < transcript.length; i++) {
			const entry = transcript[i];

			// Skip invalid entries
			if (
				typeof entry.text !== 'string' ||
				typeof entry.timestamp !== 'string' ||
				typeof entry.speaker !== 'string'
			) {
				console.warn(`Skipping entry with missing/invalid fields at index ${i}:`, entry);
				continue;
			}

			const startTimeSeconds = parseTimeToSeconds(entry.timestamp);

			// Check if parsing failed
			if (isNaN(startTimeSeconds)) {
				console.warn(
					`Skipping entry due to invalid timestamp format at index ${i}: "${entry.timestamp}"`
				);
				continue;
			}

			// Determine end time
			let endTimeSeconds;
			if (i < transcript.length - 1) {
				const nextEntry = transcript[i + 1];
				// Check if next entry and its timestamp are valid before parsing
				if (nextEntry && typeof nextEntry.timestamp === 'string') {
					const nextStartTimeSeconds = parseTimeToSeconds(nextEntry.timestamp);

					// Check if next timestamp parsed correctly AND is chronologically after current
					if (!isNaN(nextStartTimeSeconds) && nextStartTimeSeconds > startTimeSeconds) {
						endTimeSeconds = nextStartTimeSeconds;
					} else {
						// Fallback if next timestamp is invalid, fails parsing, or is not later
						console.warn(
							`Invalid, out-of-order, or unparsable timestamp for next entry at index ${i + 1} ("${nextEntry.timestamp}"). Using default duration for entry ${i}.`
						);
						endTimeSeconds = startTimeSeconds + defaultDuration;
					}
				} else {
					// Fallback if next entry or its timestamp field is invalid
					console.warn(
						`Invalid next entry or timestamp field at index ${i + 1}. Using default duration for entry ${i}.`
					);
					endTimeSeconds = startTimeSeconds + defaultDuration;
				}
			} else {
				endTimeSeconds = startTimeSeconds + defaultDuration;
			}

			const startTimeFormatted = formatTime(startTimeSeconds);
			const endTimeFormatted = formatTime(endTimeSeconds);

			const subtitleText = entry.text;

			// Construct the SRT block
			srtContent += `${i + 1}\n`;
			srtContent += `${startTimeFormatted} --> ${endTimeFormatted}\n`;
			srtContent += `${subtitleText}\n\n`;
		}

		const headers = new Headers();
		headers.set('Content-Type', 'text/srt; charset=utf-8');
		headers.set('Content-Disposition', 'attachment; filename="transcript.srt"');

		return new Response(srtContent, { headers });
	} catch (error) {
		console.error('Error processing request:', error);
		if (error instanceof SyntaxError) {
			return new Response('Invalid JSON body.', { status: 400 });
		}
		return new Response('An internal server error occurred.', { status: 500 });
	}
}
