import { ipcRenderer } from 'electron';
import {
    initialize,
    SessionManager,
    DecodingOptionsBuilder,
    Segment,
    AvailableModels,
} from "whisper-turbo";

class Recorder {
    private static instance: Recorder;
    private mediaRecorder: MediaRecorder | null = null;
    private audioChunks: Blob[] = [];
    private session: any;
    private isRecording: boolean = false;
    private queue: (() => Promise<void>)[] = [];
    private audioContext: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private silenceTimer: NodeJS.Timeout | null = null;
    private activityTimer: NodeJS.Timeout | null = null;
    private silenceThreshold = 0.01;
    private silenceDuration = 10000; // 2 seconds of silence to stop
    private activityDuration = 500; // 0.5 seconds of activity to start

    private constructor() { }

    public static async getInstance(): Promise<Recorder> {
        if (!Recorder.instance) {
            Recorder.instance = new Recorder();
            await Recorder.instance.initialize();
        }
        return Recorder.instance;
    }

    private async initialize() {
        await initialize();
        this.session = await new SessionManager().loadModel(
            AvailableModels.WHISPER_BASE,
            () => {
                console.log("Model loaded successfully");
            },
            (p: number) => {
                console.log(`Loading: ${p}%`);
            }
        );
    }


    private async transcribeAudio(audioData: ArrayBuffer): Promise<string> {
        function encodeWAV(audioBuffer: AudioBuffer): Uint8Array {
            const numChannels = audioBuffer.numberOfChannels;
            const sampleRate = audioBuffer.sampleRate;
            const format = 1; // PCM
            const bitDepth = 16;

            const bytesPerSample = bitDepth / 8;
            const blockAlign = numChannels * bytesPerSample;

            const bufferLength = audioBuffer.length;
            const wavDataBytes = bufferLength * numChannels * bytesPerSample;
            const headerBytes = 44;
            const totalBytes = headerBytes + wavDataBytes;

            const wavBuffer = new ArrayBuffer(totalBytes);
            const view = new DataView(wavBuffer);

            // WAV header
            writeString(view, 0, 'RIFF');
            view.setUint32(4, 36 + wavDataBytes, true);
            writeString(view, 8, 'WAVE');
            writeString(view, 12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, format, true);
            view.setUint16(22, numChannels, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * blockAlign, true);
            view.setUint16(32, blockAlign, true);
            view.setUint16(34, bitDepth, true);
            writeString(view, 36, 'data');
            view.setUint32(40, wavDataBytes, true);

            // WAV data
            const channelData = [];
            for (let channel = 0; channel < numChannels; channel++) {
                channelData.push(audioBuffer.getChannelData(channel));
            }

            let offset = 44;
            for (let i = 0; i < bufferLength; i++) {
                for (let channel = 0; channel < numChannels; channel++) {
                    const sample = Math.max(-1, Math.min(1, channelData[channel][i]));
                    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                    offset += 2;
                }
            }

            return new Uint8Array(wavBuffer);
        }

        function writeString(view: DataView, offset: number, string: string) {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        }
        let options = new DecodingOptionsBuilder().setTask(0).build();
        let transcription = '';

        if (!this.session.isErr && this.session.isOk) {
            // Convert ArrayBuffer to AudioBuffer
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            const audioBuffer = await audioContext.decodeAudioData(audioData);

            // Convert AudioBuffer to WAV format using custom encodeWAV function
            const wavUint8Array = encodeWAV(audioBuffer);

            await this.session.value.transcribe(wavUint8Array, true, options, (segment: Segment) => {
                transcription += segment.text + ' ';
                console.log(transcription);
            });

            return transcription.trim();
        } else {
            return '';
        }
    }


    public async start() {
        if (this.isRecording) {
            console.log('Recording is already in progress. Adding to queue.');
            return new Promise<void>((resolve) => {
                this.queue.push(async () => {
                    await this.record();
                    resolve();
                });
            });
        } else {
            return this.record();
        }
    }

    private async record() {
        this.isRecording = true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false,
            });

            this.audioContext = new AudioContext();
            const source = this.audioContext.createMediaStreamSource(stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            source.connect(this.analyser);

            this.mediaRecorder = new MediaRecorder(stream);
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                this.audioChunks.push(event.data);
            };

            this.mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                const arrayBuffer = await audioBlob.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                const transcription = await this.transcribeAudio(arrayBuffer);

                ipcRenderer.send('audio-data', {
                    audio: buffer.toString('base64'),  // to send this to storage
                    transcription: transcription
                });

                console.log({ transcription })

                this.audioChunks = [];
                stream.getTracks().forEach(track => track.stop());

                this.isRecording = false;
                this.processQueue();
            };

            this.startVoiceDetection();

            console.log('Audio recording started');
        } catch (error) {
            console.error('Error starting audio recording:', error);
            this.isRecording = false;
            this.processQueue();
        }
    }

    public stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        if (this.activityTimer) {
            clearTimeout(this.activityTimer);
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
        console.log('Audio recording stopped');
    }

    private processQueue() {
        if (this.queue.length > 0) {
            const nextRecording = this.queue.shift();
            if (nextRecording) {
                nextRecording();
            }
        }
    }

    private startVoiceDetection() {
        if (!this.analyser) return;

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const checkAudioLevel = () => {
            this.analyser!.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((sum, value) => sum + value, 0) / bufferLength;
            const normalizedAverage = average / 255; // Normalize to 0-1 range

            if (normalizedAverage > this.silenceThreshold) {
                this.handleActivity();
            } else {
                this.handleSilence();
            }

            requestAnimationFrame(checkAudioLevel);
        };

        checkAudioLevel();
    }

    private handleActivity() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }

        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
            if (!this.activityTimer) {
                this.activityTimer = setTimeout(() => {
                    this.mediaRecorder!.start();
                    console.log('Voice activity detected, starting recording');
                    this.activityTimer = null;
                }, this.activityDuration);
            }
        }
    }

    private handleSilence() {
        if (this.activityTimer) {
            clearTimeout(this.activityTimer);
            this.activityTimer = null;
        }

        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            if (!this.silenceTimer) {
                this.silenceTimer = setTimeout(() => {
                    this.mediaRecorder!.stop();
                    console.log('Silence detected, stopping recording');
                    this.silenceTimer = null;
                }, this.silenceDuration);
            }
        }
    }
}

export async function start() {
    const recorder = await Recorder.getInstance();
    await recorder.start();
}

export async function stop() {
    const recorder = await Recorder.getInstance();
    recorder.stop();
}

ipcRenderer.on('stop-recording', async () => {
    const recorder = await Recorder.getInstance();
    recorder.stop();
});