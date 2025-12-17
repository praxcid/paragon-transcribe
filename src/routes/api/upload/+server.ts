import { GoogleGenAI } from '@google/genai';
// FileState enum is provided by the new SDK under the name FileState
import { FileState } from '@google/genai';
import { file as tempFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
const pipelinePromise = promisify(pipeline);
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';

async function* streamChunks(stream: AsyncIterable<any>) {
	for await (const chunk of stream) {
		if (typeof chunk === 'string') {
			yield chunk;
		} else if (chunk && typeof chunk.text === 'function') {
			yield await chunk.text();
		} else {
			yield typeof chunk === 'object' ? JSON.stringify(chunk) : String(chunk);
		}
	}
}

function asyncIterableToReadableStream(iterable: AsyncIterable<any>) {
	return new ReadableStream({
		async start(controller) {
			try {
				for await (const chunk of iterable) {
					const text = typeof chunk === 'string' ? chunk : (chunk?.toString?.() || JSON.stringify(chunk));
					controller.enqueue(new TextEncoder().encode(text));
				}
				controller.close();
			} catch (err) {
				controller.error(err);
			}
		}
	});
}

export async function POST({ request }) {
	const formData = await request.formData();
	const file = formData.get('file') as File;
	const language = (formData.get('language') as string) || 'English';
	const geminiModel = (formData.get('geminiModel') as string) || 'gemini-2.5-flash';
	const isMedical = formData.get('isMedical') === 'true';

	let tempFileHandle;
	let uploadResult;

	const ai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });

	// Upload file (use runtime cast to access internal apiClient/uploader)
	try {
		tempFileHandle = await tempFile({ postfix: `.${file.name.split('.').pop()}` });

	await pipelinePromise(file.stream(), createWriteStream(tempFileHandle.path));
		// apiClient is protected on the public type; access at runtime via any
		uploadResult = await (ai as any).apiClient.uploadFile(tempFileHandle.path, {
			mimeType: file.type
		});
	} catch (error) {
		console.error(error);
		return new Response('Error uploading file', { status: 500 });
	} finally {
		if (tempFileHandle) {
			tempFileHandle.cleanup();
		}
	}

	console.log(uploadResult);

	// Generate transcript using the new SDK
	// Build contents: a file reference part and the text instruction
	const uploadName = uploadResult?.name || uploadResult?.file?.name || uploadResult?.fileName;

	const fileUri = uploadResult?.uri || uploadResult?.file?.uri || uploadResult?.fileUri;



	const glossaryFile = formData.get('glossaryFile') as File | null;
	const styleFile = formData.get('styleFile') as File | null;

	let glossaryText = '';
	let styleText = '';

	if (isMedical && glossaryFile) {
		glossaryText = await glossaryFile.text();
	}
	if (isMedical && styleFile) {
		styleText = await styleFile.text();
	}

	// Build contents after loading glossary/style text
	const contents = [
		{ fileData: { mimeType: file.type, fileUri } },
		{ text: `Generate a transcript in ${language} for this file. Always use the format mm:ss for the time. Group similar text together rather than timestamping every line. Identify and label different speakers as Speaker 1, Speaker 2, etc.${language === 'en-au' ? ' Use strictly British or Australian English spelling, grammar, and conventions throughout the transcript.' : ''}${isMedical ? ` Act as a professional medical transcriptionist and transcribe this file as a medical record, using appropriate medical terminology and formatting. Remove all filler words (such as um, uh, like, you know, etc.) as much as possible. Use punctuations as dictated and add correct punctuation where necessary for clarity and accuracy. Do not use contraction words; expand all contractions (e.g., use "do not" instead of "don't").${glossaryText ? ` Here is a glossary of terms to use and learn from while transcribing:\n${glossaryText}` : ''}${styleText ? ` Please adapt the style and formatting of the transcript to match this reference document:\n${styleText}` : ''}` : ''} Respond with the transcript in the form of this JSON schema:\n     [{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."},{"timestamp": "01:00", "speaker": "Speaker 2", "text": "Has AI has revolutionized the way we live and work?"}]` }
	];

	try {
		// Check that the file has been processed
		// The new SDK exposes `files` as a resource on the client. Use runtime casts
		// to call the public `get` method if available.
		let uploadedFile: any = undefined;
		const fileName = uploadName;
		try {
			uploadedFile = await (ai as any).files.get?.({ name: fileName });
		} catch (e) {
			// fallback to a direct request via the internal client
			try {
				const resp = await (ai as any).apiClient.request({ path: `files/${fileName}`, httpMethod: 'GET' });
				// resp may be an HttpResponse wrapper; try to extract JSON
				uploadedFile = (resp && resp.withResponse) ? await resp.withResponse().then((r: any) => r.data || r.response.json()) : await resp.json?.() || resp;
			} catch (err) {
				throw err;
			}
		}

		let retries = 0;
		const maxRetries = 3;
		const initialRetryDelay = 1000; // 1 second

	while (uploadedFile.state === FileState.PROCESSING) {
			console.log('File is processing... waiting 5 seconds before next poll.');
			await new Promise((resolve) => setTimeout(resolve, 5000));

			try {
				uploadedFile = await (ai as any).files.get?.({ name: fileName });
				retries = 0; // Reset retries on a successful API call
			} catch (error) {
				// Check if it's a 5xx error eligible for retry
				if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
					retries++;
					if (retries > maxRetries) {
						console.error(`Transcription API failed after ${maxRetries} retries.`, error);
						throw new Error('Transcription API is currently unavailable. Please try again later.');
					}

					const delay = initialRetryDelay * Math.pow(2, retries - 1); // 1s, 2s, 4s
					console.warn(
						`Transcription API error during polling, retrying in ${delay}ms... (Attempt ${retries}/${maxRetries})`
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				} else {
					// Not a retryable error, throw it to the outer catch block
					console.error('Unhandled error during file polling:', error);
					throw error;
				}
			}
		}

		if (uploadedFile.state === FileState.FAILED) {
			console.error('File processing failed for:', uploadedFile);
			return new Response(
				"Unfortunately this file couldn't be processed. The file may be corrupt or in an unsupported format.",
				{ status: 500 }
			);
		}

		let resultIter: AsyncIterable<any> | undefined;
		try {
			// Use the models streaming API on the new client
			const maxModelRetries = 3;
			let modelAttempt = 0;
			let lastModelError: any = null;

			for (; modelAttempt <= maxModelRetries; modelAttempt++) {
				try {
					resultIter = await (ai as any).models.generateContentStream?.({ model: geminiModel, contents, safetySettings, generationConfig: { responseMimeType: 'application/json' } });
					// success
					const bodyStream = asyncIterableToReadableStream(resultIter as AsyncIterable<any>);
					return new Response(bodyStream, {
						headers: {
							'Content-Type': 'text/plain',
							'Transfer-Encoding': 'chunked',
							'X-Content-Type-Options': 'nosniff'
						}
					});
				} catch (err) {
					lastModelError = err;
					// try to detect transient 503 / overloaded errors
					let statusCode: number | undefined = undefined;
					if (err && typeof err === 'object') {
						statusCode = (err as any).status || (err as any).code;
					}
					const message = err && (err as any).message ? String((err as any).message) : String(err);

					const isTransient = statusCode === 503 || /overload|unavailable|503|model is overloaded/i.test(message);
					if (!isTransient || modelAttempt === maxModelRetries) {
						// Non-retryable or out of attempts; return structured JSON error
						console.error('Error from Google Generative AI API (final):', err);
						// Try to parse embedded JSON from message if present
						let parsed: any = undefined;
						try {
							const msg = typeof message === 'string' ? message : JSON.stringify(message);
							const idx = msg.indexOf('{');
							if (idx !== -1) {
								const jsonPart = msg.slice(idx);
								parsed = JSON.parse(jsonPart);
							}
						} catch (e) {
							parsed = undefined;
						}

						const errorBody = parsed?.error || { code: statusCode || 500, message: message };
						return new Response(JSON.stringify({ error: errorBody }), { status: statusCode || 500, headers: { 'Content-Type': 'application/json' } });
					}

					// transient -> wait and retry
					const delay = 1000 * Math.pow(2, modelAttempt); // 1s, 2s, 4s...
					console.warn(`Transient model error, retrying in ${delay}ms (attempt ${modelAttempt + 1}/${maxModelRetries})`, message);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
			}

			// If we exit loop without returning, return last error
			console.error('Model generation failed after retries:', lastModelError);
			return new Response(JSON.stringify({ error: { message: String(lastModelError) } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		} catch (err) {
			console.error('Error from Google Generative AI API (outer):', err);
			return new Response(JSON.stringify({ error: { message: String(err) } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
	} catch (error) {
		console.error('Error during transcription process:', error);
		return new Response(
			'Sorry, something went wrong generating the transcript. Please try again later.',
			{ status: 500 }
		);
	}
}
