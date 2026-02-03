/**
 * VisionIntentDetector - Intelligently detects when camera capture should be activated.
 * 
 * This component solves the problem of multimodal capture only activating for explicit commands
 * like "what am I looking at" by using smart heuristic detection to understand natural language
 * requests that imply visual context.
 * 
 * NO ADDITIONAL API KEY REQUIRED! Uses the existing Estuary connection.
 * 
 * Examples that will now trigger camera:
 * - "Hey what do you think of this vase I'm looking at"
 * - "Can you help me identify this plant?"
 * - "Is this ripe enough to eat?"
 * - "What breed of dog is this?"
 * 
 * Setup in Lens Studio:
 * 1. Enable vision intent detection in SimpleAutoConnect (enabled by default)
 * 2. Optionally adjust the confidence threshold (default: 0.7)
 * 3. The component will listen to STT transcripts and trigger camera capture when appropriate
 * 
 * Integration with CameraCapture:
 * - Subscribe to the 'visionIntentDetected' event
 * - When triggered, call your camera capture logic
 */

import { EventEmitter, CameraCaptureRequest } from '../Core/EstuaryEvents';
import { EstuaryManager } from './EstuaryManager';
import { EstuaryCharacter } from './EstuaryCharacter';
import { SttResponse } from '../Models/SttResponse';
import { getInternetModule } from '../Core/EstuaryClient';

/**
 * Configuration for the vision intent detector.
 * No API key needed - uses smart heuristic detection!
 */
export interface VisionIntentConfig {
    /** API key for optional LLM service (leave empty for heuristic detection) */
    apiKey?: string;
    /** Whether to enable debug logging */
    debugLogging?: boolean;
    /** Confidence threshold for triggering camera (0-1, default: 0.7) */
    confidenceThreshold?: number;
    /** API endpoint for optional LLM (advanced, leave empty for heuristic) */
    endpoint?: string;
    /** Model to use if using LLM detection (advanced) */
    model?: string;
    /** Custom system prompt if using LLM detection (advanced) */
    customSystemPrompt?: string;
}

/**
 * Result of vision intent detection.
 */
export interface VisionIntentResult {
    /** Whether the user's message requires visual context */
    requiresVision: boolean;
    /** Confidence score (0-1) */
    confidence: number;
    /** The original transcript that was analyzed */
    transcript: string;
    /** Reason for the decision (for debugging) */
    reason?: string;
}

/**
 * Default system prompt for vision intent classification.
 * This prompt is optimized for fast, accurate classification.
 */
const DEFAULT_SYSTEM_PROMPT = `You are a vision intent classifier. Your ONLY job is to determine if a user's message requires seeing something visual to respond properly.

Output ONLY valid JSON in this exact format: {"requiresVision": boolean, "confidence": number, "reason": string}

Rules:
- requiresVision = true if the user is asking about, showing, looking at, or referring to something physical/visual that they expect you to see
- confidence = 0.0 to 1.0 based on how certain you are
- reason = brief explanation (10 words max)

Examples where requiresVision = true:
- "What do you think of this vase?" → physical object reference
- "Can you identify this plant?" → requires visual identification
- "Is this ripe?" → needs to see the item
- "Look at this sunset" → explicit visual reference
- "What breed is my dog?" → requires seeing the dog
- "Help me read this sign" → needs visual input

Examples where requiresVision = false:
- "What's the weather today?" → general question
- "Tell me a joke" → no visual needed
- "How do I make pasta?" → general knowledge
- "What time is it?" → no visual context`;

/**
 * VisionIntentDetector - Detects when user speech implies they want the AI to see something.
 */
export class VisionIntentDetector extends EventEmitter<any> {
    
    private _config: Required<VisionIntentConfig>;
    private _isListening: boolean = false;
    private _targetCharacter: EstuaryCharacter | null = null;
    private _transcriptHandler: ((response: SttResponse) => void) | null = null;
    private _pendingDetection: boolean = false;
    private _lastDetectionTime: number = 0;
    private _minDetectionGapMs: number = 2000; // Don't spam LLM calls
    
    constructor(config: VisionIntentConfig) {
        super();
        this._config = {
            endpoint: config.endpoint || 'https://api.openai.com/v1/chat/completions',
            apiKey: config.apiKey,
            model: config.model || 'gpt-4o-mini',
            debugLogging: config.debugLogging ?? false,
            confidenceThreshold: config.confidenceThreshold ?? 0.7,
            customSystemPrompt: config.customSystemPrompt || DEFAULT_SYSTEM_PROMPT
        };
    }
    
    // ==================== Properties ====================
    
    get isListening(): boolean {
        return this._isListening;
    }
    
    get debugLogging(): boolean {
        return this._config.debugLogging;
    }
    
    set debugLogging(value: boolean) {
        this._config.debugLogging = value;
    }
    
    get confidenceThreshold(): number {
        return this._config.confidenceThreshold;
    }
    
    set confidenceThreshold(value: number) {
        this._config.confidenceThreshold = Math.max(0, Math.min(1, value));
    }
    
    // ==================== Public Methods ====================
    
    /**
     * Start listening to a character's STT transcripts.
     * @param character The EstuaryCharacter to monitor
     */
    startListening(character: EstuaryCharacter): void {
        if (this._isListening) {
            this.log('Already listening');
            return;
        }
        
        this._targetCharacter = character;
        
        // Create handler for STT responses
        this._transcriptHandler = (response: SttResponse) => {
            // Only process final transcripts
            if (response.isFinal && response.text && response.text.trim().length > 0) {
                this.analyzeTranscript(response.text);
            }
        };
        
        // Subscribe to transcript events
        character.on('transcript', this._transcriptHandler);
        
        this._isListening = true;
        this.log('Started listening for vision intent');
    }
    
    /**
     * Stop listening to transcripts.
     */
    stopListening(): void {
        if (!this._isListening) {
            return;
        }
        
        if (this._targetCharacter && this._transcriptHandler) {
            this._targetCharacter.off('transcript', this._transcriptHandler);
            this._transcriptHandler = null;
        }
        
        this._targetCharacter = null;
        this._isListening = false;
        this.log('Stopped listening');
    }
    
    /**
     * Manually analyze a transcript for vision intent.
     * @param transcript The text to analyze
     * @returns Promise resolving to the detection result
     */
    async analyzeTranscript(transcript: string): Promise<VisionIntentResult | null> {
        // Rate limiting
        const now = Date.now();
        if (now - this._lastDetectionTime < this._minDetectionGapMs) {
            this.log('Skipping detection - too soon after last call');
            return null;
        }
        
        if (this._pendingDetection) {
            this.log('Skipping detection - already processing');
            return null;
        }
        
        this._pendingDetection = true;
        this._lastDetectionTime = now;
        
        this.log(`Analyzing transcript: "${transcript}"`);
        
        try {
            const result = await this.callLLM(transcript);
            
            if (result && result.requiresVision && result.confidence >= this._config.confidenceThreshold) {
                this.log(`Vision intent DETECTED (confidence: ${result.confidence.toFixed(2)}): ${result.reason}`);
                
                // Generate request ID for correlation
                const requestId = `vision-intent-${Date.now()}`;
                
                // IMMEDIATELY signal the server that an image is coming
                // This allows the server to send a vision acknowledgment like "Let me take a look!"
                // instead of generating a "I can't see" response
                this.sendVisionPendingSignal(transcript, requestId);
                
                // Emit event for camera capture
                const captureRequest: CameraCaptureRequest = {
                    request_id: requestId,
                    text: transcript
                };
                
                this.emit('visionIntentDetected', captureRequest, result);
                
                // Also trigger through EstuaryManager if available
                this.triggerCameraCapture(captureRequest);
            } else if (result) {
                this.log(`No vision intent (confidence: ${result.confidence.toFixed(2)}): ${result.reason}`);
            }
            
            this._pendingDetection = false;
            return result;
            
        } catch (error) {
            this.logError(`Detection failed: ${error}`);
            this._pendingDetection = false;
            return null;
        }
    }
    
    /**
     * Dispose of the detector and release resources.
     */
    dispose(): void {
        this.stopListening();
        this.removeAllListeners();
    }
    
    // ==================== Private Methods ====================
    
    /**
     * Call the LLM API for intent classification.
     * Uses Lens Studio's RemoteServiceHttpRequest native API.
     */
    private async callLLM(transcript: string): Promise<VisionIntentResult | null> {
        const internetModule = getInternetModule();
        
        if (!internetModule) {
            this.logError('InternetModule not available - using heuristic fallback');
            return this.heuristicDetection(transcript);
        }
        
        // Check if we have an API key
        if (!this._config.apiKey || this._config.apiKey.length === 0) {
            this.log('No LLM API key configured - using heuristic fallback');
            return this.heuristicDetection(transcript);
        }
        
        // Check if performHttpRequest is available
        if (typeof internetModule.performHttpRequest !== 'function') {
            this.log('performHttpRequest not available - using heuristic fallback');
            return this.heuristicDetection(transcript);
        }
        
        const requestBody = JSON.stringify({
            model: this._config.model,
            messages: [
                {
                    role: 'system',
                    content: this._config.customSystemPrompt
                },
                {
                    role: 'user',
                    content: transcript
                }
            ],
            temperature: 0.1,
            max_tokens: 150
        });
        
        return new Promise((resolve) => {
            try {
                // Create native Lens Studio HTTP request object
                // @ts-ignore - Lens Studio global API
                if (typeof RemoteServiceHttpRequest === 'undefined') {
                    this.log('RemoteServiceHttpRequest not available - using heuristic fallback');
                    resolve(this.heuristicDetection(transcript));
                    return;
                }
                
                // @ts-ignore - Lens Studio global API
                const request = RemoteServiceHttpRequest.create();
                request.url = this._config.endpoint;
                // @ts-ignore - Lens Studio enum
                request.method = RemoteServiceHttpRequest.HttpRequestMethod.Post;
                request.body = requestBody;
                
                // Set headers - Lens Studio requires using setHeader method
                if (typeof request.setHeader === 'function') {
                    request.setHeader('Content-Type', 'application/json');
                    request.setHeader('Authorization', `Bearer ${this._config.apiKey}`);
                } else if (request.headers) {
                    // Alternative: direct header assignment
                    request.headers = {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this._config.apiKey}`
                    };
                }
                
                internetModule.performHttpRequest(request, (response: any) => {
                    try {
                        const statusCode = response.statusCode || response.code || 0;
                        const body = response.body || '';
                        
                        if (statusCode >= 200 && statusCode < 300) {
                            const data = JSON.parse(body);
                            const content = data.choices?.[0]?.message?.content;
                            
                            if (content) {
                                // Parse the JSON response from the LLM
                                const parsed = this.parseResponse(content, transcript);
                                resolve(parsed);
                            } else {
                                this.logError('Empty response from LLM');
                                resolve(this.heuristicDetection(transcript));
                            }
                        } else {
                            this.logError(`HTTP error ${statusCode}: ${body}`);
                            resolve(this.heuristicDetection(transcript));
                        }
                    } catch (parseError) {
                        this.logError(`Failed to parse response: ${parseError}`);
                        resolve(this.heuristicDetection(transcript));
                    }
                });
            } catch (requestError) {
                this.logError(`HTTP request failed: ${requestError}`);
                // Fall back to heuristic detection on error
                resolve(this.heuristicDetection(transcript));
            }
        });
    }
    
    /**
     * Fallback when LLM HTTP request is not available.
     * Uses heuristic-based detection which is still quite effective.
     */
    private async callLLMFallback(transcript: string): Promise<VisionIntentResult> {
        this.log('Using heuristic fallback');
        return this.heuristicDetection(transcript);
    }
    
    /**
     * Heuristic-based detection as fallback when LLM is not available.
     * This is more sophisticated than simple keyword matching.
     */
    private heuristicDetection(transcript: string): VisionIntentResult {
        const lower = transcript.toLowerCase();
        
        // Strong visual indicators (high confidence)
        const strongIndicators = [
            'look at this', 'look at that', 'see this', 'see that',
            'what is this', 'what is that', 'what\'s this', 'what\'s that',
            'can you see', 'do you see', 'show you',
            'looking at', 'i\'m looking', 'i am looking',
            'this thing', 'that thing', 'what thing',
            'identify this', 'identify that', 'recognize this',
            'what kind of', 'what type of', 'what breed',
            'is this a', 'is that a', 'is this an', 'is that an',
            'read this', 'read that', 'what does this say',
            'help me with this', 'check this out'
        ];
        
        // Medium visual indicators (medium confidence)
        const mediumIndicators = [
            'this', 'that', 'here', 'over here',
            'in front of me', 'right here',
            'what do you think', 'your opinion',
            'is it', 'does it look', 'how does this look'
        ];
        
        // Context clues that suggest visual content
        const contextClues = [
            'vase', 'plant', 'flower', 'dog', 'cat', 'animal', 'bird',
            'painting', 'picture', 'photo', 'art', 'artwork',
            'food', 'dish', 'fruit', 'vegetable', 'meal',
            'shirt', 'dress', 'outfit', 'clothes', 'wearing',
            'car', 'building', 'house', 'room', 'landscape',
            'sign', 'text', 'writing', 'label', 'menu',
            'color', 'shape', 'pattern', 'design',
            'ripe', 'fresh', 'broken', 'damaged'
        ];
        
        let confidence = 0;
        let reason = 'No visual indicators found';
        
        // Check for strong indicators
        for (const indicator of strongIndicators) {
            if (lower.includes(indicator)) {
                confidence = 0.9;
                reason = `Strong indicator: "${indicator}"`;
                break;
            }
        }
        
        // Check for medium indicators + context clues
        if (confidence < 0.7) {
            let hasMediumIndicator = false;
            let hasContextClue = false;
            
            for (const indicator of mediumIndicators) {
                if (lower.includes(indicator)) {
                    hasMediumIndicator = true;
                    break;
                }
            }
            
            for (const clue of contextClues) {
                if (lower.includes(clue)) {
                    hasContextClue = true;
                    break;
                }
            }
            
            if (hasMediumIndicator && hasContextClue) {
                confidence = 0.75;
                reason = 'Deictic reference + visual context clue';
            } else if (hasMediumIndicator) {
                confidence = 0.5;
                reason = 'Deictic reference without clear context';
            } else if (hasContextClue) {
                confidence = 0.4;
                reason = 'Visual context clue only';
            }
        }
        
        return {
            requiresVision: confidence >= this._config.confidenceThreshold,
            confidence: confidence,
            transcript: transcript,
            reason: reason
        };
    }
    
    /**
     * Parse the LLM response into a structured result.
     */
    private parseResponse(content: string, transcript: string): VisionIntentResult {
        try {
            // Try to extract JSON from the response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    requiresVision: Boolean(parsed.requiresVision),
                    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
                    transcript: transcript,
                    reason: parsed.reason || 'LLM classification'
                };
            }
        } catch (e) {
            this.logError(`Failed to parse LLM JSON: ${e}`);
        }
        
        // Fallback: look for yes/no in response
        const lower = content.toLowerCase();
        if (lower.includes('true') || lower.includes('yes') || lower.includes('requires vision')) {
            return {
                requiresVision: true,
                confidence: 0.6,
                transcript: transcript,
                reason: 'Parsed from non-JSON response'
            };
        }
        
        return {
            requiresVision: false,
            confidence: 0.5,
            transcript: transcript,
            reason: 'Could not parse LLM response'
        };
    }
    
    /**
     * Send vision_pending signal to the server.
     * This tells the server that an image is about to be sent,
     * allowing it to generate a vision acknowledgment instead of
     * responding with "I can't see what you're looking at".
     */
    private sendVisionPendingSignal(transcript: string, requestId: string): void {
        const manager = EstuaryManager.instance;
        if (manager) {
            manager.sendVisionPending(transcript, requestId);
            this.log(`Sent vision_pending signal to server for: ${requestId}`);
        } else {
            this.log('EstuaryManager not available - cannot send vision_pending signal');
        }
    }

    /**
     * Trigger camera capture through EstuaryManager.
     */
    private triggerCameraCapture(request: CameraCaptureRequest): void {
        // Emit through the manager's event system so CameraCapture component receives it
        const manager = EstuaryManager.instance;
        if (manager) {
            // Emit the cameraCaptureRequest event
            manager.emit('cameraCaptureRequest', request);
            this.log(`Triggered camera capture: ${request.request_id}`);
        } else {
            this.log('EstuaryManager not available - event emitted locally only');
        }
    }
    
    // ==================== Logging ====================
    
    private log(message: string): void {
        if (this._config.debugLogging) {
            print(`[VisionIntentDetector] ${message}`);
        }
    }
    
    private logError(message: string): void {
        print(`[VisionIntentDetector] ERROR: ${message}`);
    }
}

/**
 * VisionIntentDetectorComponent - Lens Studio component wrapper for VisionIntentDetector.
 * 
 * Enables natural language camera activation - no additional API key needed!
 * Uses smart heuristic detection to understand phrases like "what do you think of this vase?"
 * 
 * Setup in Lens Studio:
 * 1. Create a SceneObject and add this script
 * 2. Adjust confidence threshold if needed
 * 3. This will automatically integrate with EstuaryCharacter and CameraCapture
 */
@component
export class VisionIntentDetectorComponent extends BaseScriptComponent {
    
    // ==================== Configuration (set in Inspector) ====================
    
    /**
     * Confidence threshold (0-1) for triggering camera capture.
     * Lower = more sensitive (more triggers), Higher = more selective (fewer false positives).
     * Default 0.7 balances sensitivity with avoiding false triggers.
     */
    @input
    @hint("Confidence threshold for triggering camera (0-1)")
    confidenceThreshold: number = 0.7;
    
    /**
     * Enable debug logging.
     */
    @input
    @hint("Enable debug logging")
    debugMode: boolean = true;
    
    /**
     * Auto-connect to EstuaryCharacter when available.
     */
    @input
    @hint("Automatically connect to EstuaryCharacter")
    autoConnect: boolean = true;
    
    // ==================== State ====================
    
    private _detector: VisionIntentDetector | null = null;
    private _connected: boolean = false;
    
    // ==================== Singleton ====================
    
    private static _instance: VisionIntentDetectorComponent | null = null;
    
    static get instance(): VisionIntentDetectorComponent | null {
        return VisionIntentDetectorComponent._instance;
    }
    
    static get hasInstance(): boolean {
        return VisionIntentDetectorComponent._instance !== null;
    }
    
    // ==================== Properties ====================
    
    /**
     * Get the underlying VisionIntentDetector instance.
     */
    get detector(): VisionIntentDetector | null {
        return this._detector;
    }
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        // Register singleton
        if (VisionIntentDetectorComponent._instance === null) {
            VisionIntentDetectorComponent._instance = this;
        }
        
        // Create detector with heuristic detection (no external API needed)
        this._detector = new VisionIntentDetector({
            apiKey: '', // Uses heuristic detection - no external API needed
            confidenceThreshold: this.confidenceThreshold,
            debugLogging: this.debugMode
        });
        
        // Auto-connect on start
        if (this.autoConnect) {
            this.createEvent('OnStartEvent').bind(() => {
                this.tryConnect();
            });
        }
        
        this.log("VisionIntentDetectorComponent initialized");
        this.log("Natural language camera activation enabled (e.g., 'what do you think of this vase?')");
    }
    
    onDestroy() {
        if (this._detector) {
            this._detector.dispose();
            this._detector = null;
        }
        
        if (VisionIntentDetectorComponent._instance === this) {
            VisionIntentDetectorComponent._instance = null;
        }
    }
    
    // ==================== Public Methods ====================
    
    /**
     * Connect to an EstuaryCharacter to listen for transcripts.
     * @param character The character to monitor
     */
    connectToCharacter(character: EstuaryCharacter): void {
        if (this._detector && character) {
            this._detector.startListening(character);
            this._connected = true;
            this.log(`Connected to character: ${character.characterId}`);
        }
    }
    
    /**
     * Disconnect from the current character.
     */
    disconnect(): void {
        if (this._detector) {
            this._detector.stopListening();
            this._connected = false;
            this.log("Disconnected from character");
        }
    }
    
    /**
     * Manually analyze a transcript for vision intent.
     * @param transcript The text to analyze
     */
    analyzeTranscript(transcript: string): void {
        if (this._detector) {
            this._detector.analyzeTranscript(transcript);
        }
    }
    
    /**
     * Subscribe to vision intent detection events.
     * @param handler Callback when vision intent is detected
     * @returns Unsubscribe function
     */
    onVisionIntent(handler: (request: CameraCaptureRequest, result: VisionIntentResult) => void): () => void {
        if (this._detector) {
            this._detector.on('visionIntentDetected', handler);
            return () => {
                if (this._detector) {
                    this._detector.off('visionIntentDetected', handler);
                }
            };
        }
        return () => {};
    }
    
    // ==================== Private Methods ====================
    
    /**
     * Try to connect to an EstuaryCharacter via EstuaryManager.
     */
    private tryConnect(): void {
        // Try to find EstuaryCharacter through the manager
        const delayedEvent = this.createEvent('DelayedCallbackEvent');
        delayedEvent.bind(() => {
            if (this._connected) return;
            
            // Check if manager has an active character
            const manager = EstuaryManager.instance;
            if (manager && (manager as any)._activeCharacter) {
                const character = (manager as any)._activeCharacter as EstuaryCharacter;
                this.connectToCharacter(character);
            } else {
                // Retry in a bit
                this.log("Waiting for EstuaryCharacter...");
                const retryEvent = this.createEvent('DelayedCallbackEvent');
                retryEvent.bind(() => this.tryConnect());
                (retryEvent as any).reset(1.0);
            }
        });
        (delayedEvent as any).reset(0.5);
    }
    
    // ==================== Logging ====================
    
    private log(message: string): void {
        if (this.debugMode) {
            print(`[VisionIntentDetector] ${message}`);
        }
    }
}
