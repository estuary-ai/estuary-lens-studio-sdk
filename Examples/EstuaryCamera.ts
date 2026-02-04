/**
 * CameraCapture - Component for handling camera capture requests on Spectacles.
 * 
 * This component responds to camera capture requests from:
 * 1. Server-side detection (explicit commands like "what am I looking at")
 * 2. VisionIntentDetector (natural language like "what do you think of this vase?")
 * 
 * The component captures an image using the CameraModule API at a configurable resolution,
 * and sends it back for AI vision analysis.
 * 
 * Setup in Lens Studio:
 * 1. Create a Scene Object and add this script
 * 2. Make sure you have EstuaryCredentials and EstuaryVoiceConnection (or EstuaryManager) set up
 * 3. Enable "Extended Permissions" in Project Settings for development
 *    (allows both camera access and WebSocket together)
 * 4. Optionally adjust "captureResolution" (default 512px) in the Inspector
 * 5. (Recommended) Add VisionIntentDetectorComponent for natural language camera activation
 * 
 * Usage:
 * - Explicit commands: "What am I looking at?" (server-side detection)
 * - Natural language: "Hey what do you think of this vase I'm looking at?" (requires VisionIntentDetector)
 * 
 * Natural Language Camera Activation (NEW):
 * To enable natural language camera activation, add the VisionIntentDetectorComponent:
 * 1. Create another SceneObject and add VisionIntentDetectorComponent script
 * 2. Set your LLM API key (OpenAI by default)
 * 3. The VisionIntentDetector will analyze speech and trigger camera when appropriate
 * 
 * Vision Acknowledgment:
 * Enable "enableVisionAcknowledgment" to have the character say a quick phrase
 * (e.g., "Let me take a look!") before analyzing the image. This provides
 * immediate feedback while the camera captures and processes the image.
 * 
 * Resolution:
 * - Default is 512px (smaller dimension), which gives good quality while keeping payload small
 * - Adjust captureResolution in Inspector for different quality/size tradeoffs
 * - Higher resolution = better AI analysis but larger payload
 * 
 * Note: CameraModule is a Spectacles-only API. This will not work in Lens Studio Preview.
 * Deploy to Spectacles to test camera capture functionality.
 * 
 * Privacy Note: Using CameraModule disables open internet access for publicly released Lenses.
 * Extended Permissions are required for development/testing but such Lenses cannot be released.
 */

import { EstuaryManager } from '../src/Components/EstuaryManager';
import { CameraCaptureRequest } from '../src/Core/EstuaryEvents';

@component
export class CameraCapture extends BaseScriptComponent {
    
    // ==================== Configuration ====================
    
    /**
     * Enable debug logging
     */
    @input
    @hint("Enable debug logging")
    debugMode: boolean = true;
    
    /**
     * Image capture resolution (smaller dimension).
     * Default 512 provides good balance of quality and transfer speed.
     */
    @input
    @hint("Camera capture resolution (smaller dimension in pixels)")
    captureResolution: number = 512;
    
    /**
     * Enable vision acknowledgment.
     * When true, the character will say a quick phrase (e.g., "Let me take a look!")
     * before analyzing the captured image. This provides immediate feedback to the user.
     */
    @input
    @hint("Character says acknowledgment before analyzing image")
    enableVisionAcknowledgment: boolean = true;
    
    // ==================== CameraModule ====================
    
    /**
     * CameraModule instance for Spectacles camera access.
     * Uses require() as per Lens Studio's module system.
     */
    // @ts-ignore - Lens Studio module system
    private cameraModule: CameraModule = require('LensStudio:CameraModule');
    
    /** Camera texture for continuous frame access */
    private _cameraTexture: Texture | null = null;
    
    /** Flag indicating camera is initialized and receiving frames */
    private _cameraReady: boolean = false;
    
    // ==================== State ====================
    
    private _pendingRequest: CameraCaptureRequest | null = null;
    private _isSubscribed: boolean = false;
    private _isCapturing: boolean = false;
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        this.log('CameraCapture initializing...');
        
        // IMPORTANT: CameraModule APIs (createImageRequest, etc.) cannot be called in onAwake!
        // Must wait for OnStartEvent or later
        this.createEvent('OnStartEvent').bind(() => {
            this.initialize();
        });
    }
    
    /**
     * Initialize the component after OnStartEvent.
     * CameraModule APIs are available here.
     */
    private initialize(): void {
        this.log('Initializing CameraModule integration...');
        
        // Verify CameraModule is available
        if (!this.cameraModule) {
            this.logError('CameraModule not available! This only works on Spectacles hardware.');
            return;
        }
        
        // Set up camera with custom resolution
        this.setupCamera();
        
        this.subscribeToEvents();
    }
    
    /**
     * Set up camera with custom resolution using requestCamera().
     * This provides continuous frame access at the specified resolution.
     */
    private setupCamera(): void {
        try {
            this.log(`Setting up camera with resolution: ${this.captureResolution}px`);
            
            // @ts-ignore - Lens Studio API
            const cameraRequest = CameraModule.createCameraRequest();
            
            // Set the camera ID (Default_Color works for most cases)
            // @ts-ignore - Lens Studio API
            cameraRequest.cameraId = CameraModule.CameraId.Default_Color;
            
            // Set custom resolution - imageSmallerDimension controls the smaller edge
            // For 512, this gives us approximately 512x384 or similar aspect ratio
            cameraRequest.imageSmallerDimension = this.captureResolution;
            
            // Request camera - returns a texture that updates continuously
            this._cameraTexture = this.cameraModule.requestCamera(cameraRequest);
            
            if (!this._cameraTexture) {
                this.logError('Failed to get camera texture');
                return;
            }
            
            // Set up frame callback to know when camera is ready
            // @ts-ignore - Lens Studio API
            const provider = this._cameraTexture.control as CameraTextureProvider;
            if (provider && provider.onNewFrame) {
                provider.onNewFrame.add((frame: any) => {
                    if (!this._cameraReady) {
                        // @ts-ignore
                        const width = this._cameraTexture!.getWidth();
                        // @ts-ignore
                        const height = this._cameraTexture!.getHeight();
                        this.log(`Camera ready: ${width}x${height}`);
                        this._cameraReady = true;
                    }
                });
                this.log('Camera frame callback registered');
            } else {
                // Fallback - assume ready after a short delay
                this.log('No onNewFrame event, assuming camera ready');
                this._cameraReady = true;
            }
            
        } catch (error) {
            this.logError(`Failed to setup camera: ${error}`);
        }
    }
    
    private subscribeToEvents(): void {
        if (this._isSubscribed) return;
        
        const manager = EstuaryManager.instance;
        if (!manager) {
            this.logError('EstuaryManager not found! Make sure it is initialized first.');
            return;
        }
        
        // Subscribe to camera capture requests from the server
        manager.on('cameraCaptureRequest', (request: CameraCaptureRequest) => {
            this.handleCaptureRequest(request);
        });
        
        // Send vision acknowledgment preference to backend when connected
        // If already connected, send immediately; otherwise wait for connection
        if (manager.isConnected) {
            this.sendVisionPreference();
        }
        manager.on('connectionStateChanged', (state: any) => {
            if (state === 'connected') {
                this.sendVisionPreference();
            }
        });
        
        this._isSubscribed = true;
        this.log('Subscribed to camera capture requests');
        this.log(`Vision acknowledgment: ${this.enableVisionAcknowledgment ? 'enabled' : 'disabled'}`);
        this.log('Camera capture can be triggered by:');
        this.log('  1. Explicit commands: "What am I looking at?"');
        this.log('  2. Natural language (with VisionIntentDetector): "What do you think of this vase?"');
    }
    
    /**
     * Send the vision acknowledgment preference to the backend.
     */
    private sendVisionPreference(): void {
        const manager = EstuaryManager.instance;
        if (!manager || !manager.isConnected) return;
        
        manager.updatePreferences({
            enableVisionAcknowledgment: this.enableVisionAcknowledgment
        });
        this.log(`Sent vision acknowledgment preference: ${this.enableVisionAcknowledgment}`);
    }
    
    // ==================== Camera Capture ====================
    
    /**
     * Handle a camera capture request from the server.
     */
    private handleCaptureRequest(request: CameraCaptureRequest): void {
        // Prevent duplicate captures
        if (this._isCapturing) {
            this.log('Already capturing, ignoring duplicate request');
            return;
        }
        
        print('');
        print('================================================');
        print('CAMERA CAPTURE REQUEST RECEIVED!');
        print(`Request ID: ${request.request_id}`);
        print(`Context: ${request.text || '(none)'}`);
        print('Capturing high-resolution still image...');
        print('================================================');
        print('');
        
        this._pendingRequest = request;
        this._isCapturing = true;
        
        // Capture the image using CameraModule
        this.captureAndSend();
    }
    
    /**
     * Capture the current camera frame and send it to the server.
     * Uses the pre-initialized camera texture at the configured resolution.
     */
    private captureAndSend(): void {
        // Check if camera is ready
        if (!this._cameraTexture || !this._cameraReady) {
            this.logError('Camera not ready! Make sure CameraModule is initialized.');
            this._pendingRequest = null;
            this._isCapturing = false;
            return;
        }
        
        try {
            // @ts-ignore - Lens Studio API
            const width = this._cameraTexture.getWidth();
            // @ts-ignore - Lens Studio API
            const height = this._cameraTexture.getHeight();
            this.log(`Capturing frame: ${width}x${height}`);
            
            // Encode and send the current frame
            this.encodeAndSendTexture(this._cameraTexture);
            
        } catch (error) {
            this.logError(`Frame capture failed: ${error}`);
            this._pendingRequest = null;
            this._isCapturing = false;
        }
    }
    
    /**
     * Encode the captured texture to Base64 and send to server.
     */
    private encodeAndSendTexture(texture: Texture): void {
        this.log('Encoding texture to Base64...');
        
        // @ts-ignore - Lens Studio global API
        if (typeof Base64 === 'undefined' || !Base64.encodeTextureAsync) {
            this.logError('Base64.encodeTextureAsync not available');
            this._pendingRequest = null;
            this._isCapturing = false;
            return;
        }
        
        // Use IntermediateQuality for good balance of quality and size
        // At 512px resolution, this produces reasonably sized payloads
        // @ts-ignore - Lens Studio global enums
        const compressionQuality = typeof CompressionQuality !== 'undefined' 
            ? CompressionQuality.IntermediateQuality 
            : 2; // IntermediateQuality = 2
        
        // @ts-ignore - Lens Studio global enums
        const encodingType = typeof EncodingType !== 'undefined'
            ? EncodingType.Jpg
            : 1; // Jpg = 1
        
        // @ts-ignore - Lens Studio API
        Base64.encodeTextureAsync(
            texture,
            (encodedString: string) => {
                this.log(`Encoded texture: ${encodedString.length} chars`);
                this.sendToServer(encodedString);
            },
            () => {
                this.logError('Base64.encodeTextureAsync failed');
                this._pendingRequest = null;
                this._isCapturing = false;
            },
            compressionQuality,
            encodingType
        );
    }
    
    /**
     * Send the encoded image to the Estuary server.
     */
    private sendToServer(imageBase64: string): void {
        const manager = EstuaryManager.instance;
        if (!manager) {
            this.logError('EstuaryManager not available');
            this._pendingRequest = null;
            this._isCapturing = false;
            return;
        }
        
        manager.sendCameraImage(
            imageBase64,
            'image/jpeg',
            this._pendingRequest?.request_id,
            this._pendingRequest?.text
        );
        
        print('');
        print('================================================');
        print('IMAGE SENT TO SERVER FOR ANALYSIS!');
        print('================================================');
        print('');
        
        this._pendingRequest = null;
        this._isCapturing = false;
    }
    
    /**
     * Manually trigger a camera capture (for testing).
     * Call this from another script or via a tap event.
     */
    manualCapture(text?: string): void {
        if (this._isCapturing) {
            this.log('Already capturing, ignoring manual trigger');
            return;
        }
        
        this.log('Manual capture triggered');
        this._pendingRequest = {
            request_id: 'manual-' + Date.now(),
            text: text || 'What do you see?'
        };
        this._isCapturing = true;
        this.captureAndSend();
    }
    
    // ==================== Logging ====================
    
    private log(message: string): void {
        if (this.debugMode) {
            print(`[CameraCapture] ${message}`);
        }
    }
    
    private logError(message: string): void {
        print(`[CameraCapture] ERROR: ${message}`);
    }
}
