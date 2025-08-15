import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { file as tempFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
	for await (const chunk of stream) {
		yield chunk.text();
	}
}

export async function POST({ request }) {
	const formData = await request.formData();
	const file = formData.get('file') as File;
	const language = (formData.get('language') as string) || 'English';

	let tempFileHandle;
	let uploadResult;

	const fileManager = new GoogleAIFileManager(env.GOOGLE_API_KEY);

	// Upload file
	try {
		tempFileHandle = await tempFile({ postfix: `.${file.name.split('.').pop()}` });

		await pipeline(file.stream(), createWriteStream(tempFileHandle.path));
		uploadResult = await fileManager.uploadFile(tempFileHandle.path, {
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

	// Generate transcript
	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

	const model = genAI.getGenerativeModel({
		model: 'gemini-2.5-flash',
		safetySettings,
		generationConfig: { responseMimeType: 'application/json' }
	});

	try {
		// Check that the file has been processed
		let uploadedFile = await fileManager.getFile(uploadResult.file.name);

		let retries = 0;
		const maxRetries = 3;
		const initialRetryDelay = 1000; // 1 second

		while (uploadedFile.state === FileState.PROCESSING) {
			console.log('File is processing... waiting 5 seconds before next poll.');
			await new Promise((resolve) => setTimeout(resolve, 5000));

			try {
				uploadedFile = await fileManager.getFile(uploadResult.file.name);
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

		const result = await model.generateContentStream([
			{
				fileData: {
					mimeType: file.type,
					fileUri: uploadResult.file.uri
				}
			},
			{
				text: `Generate a transcript in ${language} for this file. Always use the format mm:ss for the time. Group similar text together rather than timestamping every line. Respond with the transcript in the form of this JSON schema:
     [{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."},{"timestamp": "01:00", "speaker": "Speaker 1", "text": "Has AI has revolutionized the way we live and work?"}]`
			}
		]);

		return new Response(streamChunks(result.stream), {
			headers: {
				'Content-Type': 'text/plain',
				'Transfer-Encoding': 'chunked',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (error) {
		console.error('Error during transcription process:', error);
		return new Response(
			'Sorry, something went wrong generating the transcript. Please try again later.',
			{ status: 500 }
		);
	}
}
