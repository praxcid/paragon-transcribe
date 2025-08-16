<script lang="ts">
	import { onMount } from 'svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import JSZip from 'jszip';

	let selectedFiles: File[] = [];
	let fileUrls: string[] = [];
	let fileTypes: ('audio' | 'video')[] = [];
	let uploadComplete = false;
	let isUploading = false;
	let streamBuffer = '';
	let fileTranscripts: Array<{ fileName: string; entries: Array<{ timestamp: string; speaker: string; text: string }> }> = [];
	let language = 'en';
	const languageOptions = [
		{ value: 'auto', label: 'Auto Detect' },
		{ value: 'en', label: 'English' },
		{ value: 'en-au', label: 'Australian English' },
		{ value: 'ne-romanized', label: 'Nepali (Romanized/English Letters)' },
		{ value: 'ne', label: 'Nepali (Devanagari Script)' }
	];
	let initialized = false;
	let showTimestamps = false;
	let showSpeakers = false;
	// Add a variable for the Medical checkbox
	let isMedical = false;

	let audioElements: HTMLAudioElement[] = [];
	let videoElements: HTMLVideoElement[] = [];

	// Add Gemini model selection
	let geminiModel = 'gemini-2.5-flash';
	const geminiModelOptions = [
		{ value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
		{ value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
		{ value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
		{ value: 'gemini-1.0-pro', label: 'Gemini 1.0 Pro' }
	];

	onMount(() => {
		language = localStorage.getItem('transcriptionLanguage') || 'English';
		initialized = true;
	});

	$: if (initialized) {
		localStorage.setItem('transcriptionLanguage', language);
	}

	function handleTimestampClick(timestamp: string) {
		const parts = timestamp.split(':').map(Number);
		let timeInSeconds = 0;

		if (parts.length === 3) {
			timeInSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
		} else if (parts.length === 2) {
			timeInSeconds = parts[0] * 60 + parts[1]; // mm:ss
		}

		audioElements.forEach(audioElement => {
			audioElement.currentTime = timeInSeconds;
			audioElement.play();
		});

		videoElements.forEach(videoElement => {
			videoElement.currentTime = timeInSeconds;
			videoElement.play();
		});
	}

	function handleFileInput(event: Event) {
		const target = event.target as HTMLInputElement;
		const newFiles = target.files ? Array.from(target.files) : [];
		// Append new files, avoiding duplicates by name and size
		const existingNames = new Set(selectedFiles.map(f => f.name + f.size));
		const uniqueNewFiles = newFiles.filter(f => !existingNames.has(f.name + f.size));
		selectedFiles = [...selectedFiles, ...uniqueNewFiles];
		fileUrls = selectedFiles.map(file => URL.createObjectURL(file));
		fileTypes = selectedFiles.map(file => file.type.includes('audio') ? 'audio' : 'video');
	}

	function parseStreamedJson(
		buffer: string
	): Array<{ timestamp: string; speaker: string; text: string }> {
		const objectStrings = buffer.match(/{[^}]*}/g); // This regex attempts to find all substrings that look like complete JSON objects
		if (!objectStrings) {
			return [];
		}

		return objectStrings
			.map((objStr) => {
				try {
					const parsed = JSON.parse(objStr);
					if (
						parsed &&
						typeof parsed.timestamp === 'string' &&
						typeof parsed.speaker === 'string' &&
						typeof parsed.text === 'string'
					) {
						return parsed;
					}
					return null;
				} catch (e) {
					// This object string is likely incomplete or malformed, so we skip it
					// The next chunk from the stream might complete it
					return null;
				}
			})
			.filter((entry): entry is { timestamp: string; speaker: string; text: string } => !!entry);
	}

	let abortController: AbortController | null = null;

	function stopProcessing() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
		selectedFiles = [];
		fileUrls = [];
		fileTypes = [];
		uploadComplete = false;
		isUploading = false;
		streamBuffer = '';
		fileTranscripts = [];
		audioElements.forEach(audioElement => {
			audioElement.currentTime = 0;
			audioElement.pause();
		});
		videoElements.forEach(videoElement => {
			videoElement.currentTime = 0;
			videoElement.pause();
		});
		glossaryFile = null;
		styleFile = null;
		// Reset file input element
		if (fileInputEl) fileInputEl.value = '';
	}

	async function handleSubmit() {
		if (!selectedFiles.length) return;
		fileTranscripts = [];
		isUploading = true;
		for (let i = 0; i < selectedFiles.length; i++) {
			const file = selectedFiles[i];
			const fileUrl = fileUrls[i];
			const fileType = fileTypes[i];
			// Only allow files that are less than 2 hours in length
			const tempMediaElement = document.createElement(fileType === 'audio' ? 'audio' : 'video');
			tempMediaElement.src = fileUrl;
			const duration = await new Promise<number>((resolve, reject) => {
				tempMediaElement.onloadedmetadata = () => resolve(tempMediaElement.duration);
				tempMediaElement.onerror = reject;
			});
			if (duration >= 7200) {
				alert(`File '${file.name}' is too long. Please select a file that is less than 2 hours in length.`);
				continue;
			}
			const formData = new FormData();
			formData.append('file', file);
			formData.append('language', language);
			// In handleSubmit, add isMedical to the FormData
			formData.append('isMedical', isMedical ? 'true' : 'false');
			// In handleSubmit, add geminiModel to the FormData
			formData.append('geminiModel', geminiModel);
			// In handleSubmit, append glossaryFile and styleFile if present
			if (isMedical && glossaryFile) {
				formData.append('glossaryFile', glossaryFile);
			}
			if (isMedical && styleFile) {
				formData.append('styleFile', styleFile);
			}
			abortController = new AbortController();
			const response = await fetch('/api/upload', {
				method: 'POST',
				body: formData,
				headers: {
					Connection: 'keep-alive'
				},
				signal: abortController.signal
			});
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('Response body is missing');
			}
			const decoder = new TextDecoder();
			streamBuffer = '';
			let fileTranscript: Array<{ timestamp: string; speaker: string; text: string }> = [];
			// Add an empty transcript for this file so UI updates as lines are added
			fileTranscripts = [...fileTranscripts, { fileName: file.name, entries: [] }];
			let fileIndex = fileTranscripts.length - 1;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						let parsedData;
						try {
							parsedData = JSON.parse(streamBuffer);
						} catch (error) {
							const response = await fetch('/api/fix-json', {
								method: 'POST',
								headers: { 'Content-Type': 'text/plain' },
								body: streamBuffer
							});
							parsedData = (await response.json()).formattedJSON;
						}
						fileTranscript = parsedData;
						// Update the transcript for this file with the final data
						fileTranscripts[fileIndex].entries = fileTranscript;
						streamBuffer = '';
						break;
					}
					streamBuffer += decoder.decode(value, { stream: true });
					// Try to parse partial JSON array for progressive display
					let partialTranscript = parseStreamedJson(streamBuffer);
					if (partialTranscript && Array.isArray(partialTranscript)) {
						fileTranscripts[fileIndex].entries = partialTranscript;
					}
				}
			} finally {
				reader.cancel();
			}
		}
		abortController = null;
		uploadComplete = true;
		isUploading = false;
	}

	async function downloadTranscript({ timestamps = true } = {}) {
		const response = await fetch('/api/download', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: fileTranscripts, timestamps })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.txt';
		a.click();
	}

	async function downloadSRT() {
		const response = await fetch('/api/srt', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: fileTranscripts })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.srt';
		a.click();
	}

	// Utility function to remove accent marks from a string
	function removeAccents(str: string): string {
		return str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
	}

	// Add a function to download a single transcript for a file
	function downloadSingleTranscript(fileT) {
		const lines = fileT.entries.map(entry => {
			let line = '';
			if (showTimestamps) line += `[${entry.timestamp}] `;
			if (showSpeakers) line += `${entry.speaker}: `;
			line += removeAccents(entry.text);
			return line;
		});
		const blob = new Blob([lines.join('\n')], { type: 'application/msword' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = fileT.fileName.replace(/\.[^/.]+$/, '') + `-transcript-${geminiModel}.doc`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}

	async function downloadAllTranscripts() {
		const zip = new JSZip();
		fileTranscripts.forEach(fileT => {
			const lines = fileT.entries.map(entry => {
				let line = '';
				if (showTimestamps) line += `[${entry.timestamp}] `;
				if (showSpeakers) line += `${entry.speaker}: `;
				line += removeAccents(entry.text);
				return line;
			});
			const docName = fileT.fileName.replace(/\.[^/.]+$/, '') + `-transcript-${geminiModel}.doc`;
			zip.file(docName, lines.join('\n'));
		});
		const content = await zip.generateAsync({ type: 'blob' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(content);
		a.download = 'transcripts.zip';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}

	function reset() {
		selectedFiles = [];
		uploadComplete = false;
		isUploading = false;
		fileUrls = [];
		streamBuffer = '';
		fileTranscripts = [];
		audioElements.forEach(audioElement => {
			audioElement.currentTime = 0;
			audioElement.pause();
		});
		videoElements.forEach(videoElement => {
			videoElement.currentTime = 0;
			videoElement.pause();
		});
	}

	function removeFile(index: number) {
		selectedFiles = selectedFiles.slice(0, index).concat(selectedFiles.slice(index + 1));
		fileUrls = selectedFiles.map(file => URL.createObjectURL(file));
		fileTypes = selectedFiles.map(file => file.type.includes('audio') ? 'audio' : 'video');
	}

	// Add state for glossary and style files
	let glossaryFile: File | null = null;
	let styleFile: File | null = null;

	function handleGlossaryFileInput(event: Event) {
		const target = event.target as HTMLInputElement;
		glossaryFile = target.files && target.files[0] ? target.files[0] : null;
	}

	function handleStyleFileInput(event: Event) {
		const target = event.target as HTMLInputElement;
		styleFile = target.files && target.files[0] ? target.files[0] : null;
	}

	// Add a ref for the file input
	let fileInputEl: HTMLInputElement | null = null;
</script>

<svelte:head>
	<title>Paragon Transcribe</title>
</svelte:head>

<div class="flex min-h-screen flex-col bg-gradient-to-br from-indigo-50 via-white to-cyan-50">
	<div
		class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiMzNzM2ZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-30"
	></div>

	<main class="container relative z-10 mx-auto flex-grow px-4 py-8">
		<section class="mb-6 text-center">
			<h1
				class="mb-4 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-3xl font-bold text-transparent md:text-4xl"
			>
				   PARAGON TRANSCRIPTION SERVICES
			</h1>

		</section>

		<div class="mx-auto max-w-4xl mt-10">
			{#if uploadComplete}
				<!-- Media Player Section -->
				<div
					class="mb-8 rounded-xl border border-indigo-200 bg-white/80 p-8 shadow-xl shadow-indigo-500/10 backdrop-blur-sm"
				>
					<div class="mb-8">
						{#each fileUrls as fileUrl, index}
							{#if fileTypes[index] === 'audio'}
								<audio
									src={fileUrl}
									controls
									class="h-12 w-full rounded-lg shadow-lg shadow-indigo-500/20"
									bind:this={audioElements[index]}
								/>
							{:else if fileTypes[index] === 'video'}
								<video
									src={fileUrl}
									controls
									class="w-full rounded-lg shadow-xl shadow-indigo-500/20"
									bind:this={videoElements[index]}
								>
									<track kind="captions" label="English captions" src="" srclang="en" default />
								</video>
							{/if}
						{/each}
					</div>

					<!-- Download Actions -->
					<div class="mb-6 flex flex-col md:flex-row gap-4 md:gap-6 justify-center">
						<button
							on:click={downloadAllTranscripts}
							class="group relative transform overflow-hidden rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-4 font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-emerald-500/40"
						>
							<div class="relative flex items-center justify-center space-x-2">
								<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
								<span>Download All</span>
							</div>
						</button>
						<button
							on:click={reset}
							class="group relative transform overflow-hidden rounded-lg border-2 border-slate-300 bg-white/90 px-6 py-4 font-semibold text-slate-700 shadow-lg shadow-slate-500/10 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:bg-slate-50 hover:shadow-xl hover:shadow-slate-500/20"
						>
							<div class="relative flex items-center justify-center space-x-2">
								<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
									/>
								</svg>
								<span>Start Over</span>
							</div>
						</button>
					</div>
				</div>
			{:else}
				<!-- Upload Section -->
				<div
					class="mb-8 rounded-xl border border-indigo-200 bg-white/80 p-8 shadow-xl shadow-indigo-500/10 backdrop-blur-sm"
				>
					<div class="mb-8">
						<div class="flex gap-4">
							<div
								class="mb-2 inline-flex h-20 w-20 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-100 to-purple-100 shadow-lg shadow-indigo-500/20"
							>
								<svg
									class="h-10 w-10 text-indigo-600"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
									/>
								</svg>
							</div>
							<div>
								<h2 class="mb-2 text-2xl font-bold text-slate-800">Upload Your Media</h2>
								<p class="text-slate-600">Select an audio or video file to begin transcription</p>
							</div>
						</div>
					</div>

					<div class="space-y-6">
						{#if selectedFiles.length > 0}
							<div class="mb-4">
								<h3 class="text-slate-700 font-semibold mb-2">Selected Files:</h3>
								<ul class="list-disc list-inside text-slate-600 text-sm">
									{#each selectedFiles as file, i}
										<li class="flex items-center gap-2">
											{file.name}
											<button
												type="button"
												class="ml-2 px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs hover:bg-red-200"
												on:click={() => removeFile(i)}
												aria-label={`Remove ${file.name}`}
											>
												Remove
											</button>
										</li>
									{/each}
								</ul>
							</div>
						{/if}

						<div>
							<Label for="audio-file" class="mb-2 block text-sm font-medium text-slate-700">
								Choose File
							</Label>
							<div class="relative">
								<Input
									type="file"
									multiple
									on:input={handleFileInput}
									id="audio-file"
									accept="audio/*,video/*"
									bind:this={fileInputEl}
									class="block h-16 w-full rounded-lg border-2 border-indigo-200 bg-white/90 text-sm text-slate-700 shadow-sm backdrop-blur-sm file:mr-4 file:rounded-lg file:border-0 file:bg-gradient-to-r file:from-indigo-600 file:to-purple-600 file:px-6 file:py-3 file:text-sm file:font-semibold file:text-white file:transition-all file:duration-300 hover:file:shadow-lg hover:file:shadow-indigo-500/25 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
								/>
							</div>
						</div>

						<div class="mb-4">
							<label for="language" class="block text-sm font-medium text-gray-700 mb-1">Language of Transcript</label>
							<select
								id="language"
								class="block w-full rounded-md border border-gray-300 bg-white py-2 px-3 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
								bind:value={language}
							>
								{#each languageOptions as option}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>

						<!-- Add Gemini model selection -->
						<div class="mb-4">
							<label for="gemini-model" class="block text-sm font-medium text-gray-700 mb-1">Gemini AI Model</label>
							<select
								id="gemini-model"
								class="block w-full rounded-md border border-gray-300 bg-white py-2 px-3 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
								bind:value={geminiModel}
							>
								{#each geminiModelOptions as option}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>

						<div class="mt-2 mb-4 flex items-center gap-6">
							<div class="flex items-center gap-2">
								<input
									type="checkbox"
									id="show-timestamps"
									bind:checked={showTimestamps}
									class="accent-indigo-600 h-4 w-4"
								/>
								<label for="show-timestamps" class="text-slate-700 text-sm select-none cursor-pointer">
									Show Timestamps
								</label>
							</div>
							<div class="flex items-center gap-2">
								<input
									type="checkbox"
									id="show-speakers"
									bind:checked={showSpeakers}
									class="accent-indigo-600 h-4 w-4"
								/>
								<label for="show-speakers" class="text-slate-700 text-sm select-none cursor-pointer">
									Separate Speakers
								</label>
							</div>
							<!-- Add the Medical checkbox -->
							<div class="flex items-center gap-2">
								<input
									type="checkbox"
									id="medical"
									bind:checked={isMedical}
									class="accent-indigo-600 h-4 w-4"
								/>
								<label for="medical" class="text-slate-700 text-sm select-none cursor-pointer">
									Medical
								</label>
							</div>
						</div>

						<!-- Add file inputs for glossary and style reference if Medical is checked -->
						{#if isMedical}
						 <div class="flex flex-col gap-2 mt-2">
							<div class="flex items-center gap-2 mb-1">
							  <span class="px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 text-xs font-semibold">Experimental</span>
							  <span class="text-xs text-slate-600">Glossary and Style Reference features are experimental and may not always work as expected.</span>
							</div>
							<label class="block text-sm font-medium text-gray-700">Upload Glossary (.doc or .txt):
							  <input type="file" accept=".doc,.txt" on:change={handleGlossaryFileInput} class="block mt-1" />
							  {#if glossaryFile}
								<span class="text-xs text-slate-600">Selected: {glossaryFile.name}</span>
							  {/if}
							</label>
							<label class="block text-sm font-medium text-gray-700">Upload Style Reference (.doc):
							  <input type="file" accept=".doc" on:change={handleStyleFileInput} class="block mt-1" />
							  {#if styleFile}
								<span class="text-xs text-slate-600">Selected: {styleFile.name}</span>
							  {/if}
							</label>
						  </div>
						{/if}

						<button
							on:click={handleSubmit}
							class="group relative w-full transform overflow-hidden rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4 font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-500/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:transform-none"
							disabled={!selectedFiles.length || isUploading}
						>
							<div class="relative flex items-center justify-center space-x-2">
								{#if isUploading}
									<svg
										class="h-5 w-5 animate-spin"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
								{:else}
									<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
										/>
									</svg>
								{/if}
								<span>Upload & Transcribe</span>
							</div>
						</button>

						{#if isUploading}
							<div class="text-center">
								<div class="inline-flex items-center space-x-2 text-indigo-600">
									<svg
										class="h-5 w-5 animate-spin"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									<span class="font-medium">
										Processing your file... This may take a few minutes
									</span>
								</div>
							</div>
						{/if}

						{#if isUploading}
						  <div class="my-4 flex justify-center">
							<button
							  on:click={stopProcessing}
							  class="px-4 py-2 rounded bg-red-600 text-white font-semibold hover:bg-red-700"
							>
							  Stop Processing
							</button>
						  </div>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Transcript Display -->
			{#if fileTranscripts.length > 0}
				<div class="space-y-4">
					<div class="mb-8 text-center">
						<h3
							class="mb-2 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-2xl font-bold text-transparent"
						>
							Transcript
						</h3>
						<p class="text-slate-600">Click on timestamps to jump to that moment</p>
					</div>

					{#each fileTranscripts as fileT}
						<div class="mb-8">
							<div class="flex items-center justify-between mb-2">
								<h3 class="text-xl font-bold text-indigo-700">{fileT.fileName}</h3>
								<button
									class="inline-flex items-center rounded bg-indigo-600 px-3 py-1 text-sm font-semibold text-white shadow hover:bg-indigo-700"
									on:click={() => downloadSingleTranscript(fileT)}
								>
									Download Transcript
								</button>
							</div>
							<div class="space-y-4">
								{#each fileT.entries as entry, index}
									<div class="group rounded-xl border border-slate-200 bg-white/90 p-6 shadow-lg shadow-slate-500/10 backdrop-blur-sm transition-all duration-300 hover:scale-[1.01] hover:shadow-xl hover:shadow-slate-500/20">
										<div class="flex flex-col space-y-3 sm:flex-row sm:items-start sm:space-x-4 sm:space-y-0">
											{#if showTimestamps}
												<button
													class="inline-flex flex-shrink-0 transform items-center justify-center rounded-full bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:scale-105 hover:shadow-xl hover:shadow-indigo-500/40"
													on:click={() => handleTimestampClick(entry.timestamp)}
												>
													{entry.timestamp}
												</button>
											{/if}
											<div class="min-w-0 flex-1">
												{#if showSpeakers}
													<span class="inline-flex items-center rounded-full border-2 border-emerald-200 bg-gradient-to-r from-emerald-100 to-teal-100 px-3 py-1 text-sm font-semibold text-emerald-700 shadow-sm">
														{entry.speaker}
													</span>
												{/if}
												<p class="font-medium leading-relaxed text-slate-800">{removeAccents(entry.text)}</p>
											</div>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</main>

	<footer class="relative z-10 mt-auto border-t border-indigo-200 bg-white/80 backdrop-blur-sm">
		<div class="container mx-auto px-4 py-4">
			<div class="text-center text-slate-500">
				<p class="text-sm">
					<a
						href="https://paragontranscriptions.com"
						class="font-medium text-indigo-600 transition-colors duration-200 hover:text-purple-600"
					>
						www.paragontranscriptions.com
					</a>
				</p>
			</div>
		</div>
	</footer>
</div>
