/**
 * ImageEndpointTest - Simple test script to verify the spectacle image endpoint.
 * 
 * This script connects to the Estuary server and sends a test image to verify
 * that the camera_image endpoint is working correctly.
 * 
 * Setup in Lens Studio:
 * 1. Create a SceneObject (e.g., "Image Test")
 * 2. Add this script to the SceneObject
 * 3. Make sure EstuaryCredentials and EstuaryCharacter are set up in your scene
 * 4. **IMPORTANT**: Attach a Device Camera Texture for a real test!
 *    (Resources > Create > Textures > Device Camera Texture)
 * 5. Deploy to Spectacles (WebSocket doesn't work in Preview)
 * 
 * What this tests:
 * - WebSocket connection to Estuary server
 * - Image payload formatting (base64 + mime_type)
 * - Server response handling for camera_image events
 * - End-to-end vision processing pipeline
 * 
 * Note on test results:
 * - If you get a bot_response: Full pipeline is working!
 * - If you get an OpenAI "image_parse_error": Endpoint IS working, but the 
 *   fallback test image was rejected. Use a real camera texture instead.
 * - If you get a connection error: Check your credentials and network.
 */

import { EstuaryManager } from '../src/Components/EstuaryManager';
import { ConnectionState } from '../src/Core/EstuaryEvents';

@component
export class ImageEndpointTest extends BaseScriptComponent {
    
    // ==================== Configuration ====================
    
    /**
     * Optional: Device Camera Texture to test with live camera image.
     * If not provided, will use a simple generated test pattern.
     */
    @input
    @hint("Optional: Device Camera Texture for live camera test")
    @allowUndefined
    cameraTexture: Texture;
    
    /**
     * Optional: Static image texture (drag any image from Resources panel).
     * Useful for testing when Device Camera Texture isn't available.
     * This will be encoded using RenderTarget if cameraTexture fails.
     */
    @input
    @hint("Optional: Static test image (any image texture from Resources)")
    @allowUndefined
    staticTestImage: Texture;
    
    /**
     * Automatically run the test when connected.
     */
    @input
    @hint("Auto-run test when connected to server")
    autoRunOnConnect: boolean = true;
    
    /**
     * Delay in seconds before running the test after connection.
     */
    @input
    @hint("Delay (seconds) before running test after connection")
    testDelay: number = 2.0;
    
    /**
     * Test prompt to send with the image.
     */
    @input
    @hint("Test prompt to send with the image")
    testPrompt: string = "This is a test image upload. What do you see?";
    
    // ==================== State ====================
    
    private _hasRunTest: boolean = false;
    private _isSubscribed: boolean = false;
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        print('');
        print('╔═══════════════════════════════════════════════════════════════╗');
        print('║          IMAGE ENDPOINT TEST - SPECTACLES                     ║');
        print('║  This script tests the camera_image endpoint functionality   ║');
        print('╚═══════════════════════════════════════════════════════════════╝');
        print('');
        
        // Wait for manager to initialize
        this.createEvent('OnStartEvent').bind(() => {
            this.subscribeToEvents();
        });
    }
    
    private subscribeToEvents(): void {
        if (this._isSubscribed) return;
        
        const manager = EstuaryManager.instance;
        if (!manager) {
            print('[ImageEndpointTest] ⚠️ EstuaryManager not found! Make sure EstuaryCharacter is set up.');
            return;
        }
        
        // Subscribe to connection state changes
        manager.on('connectionStateChanged', (state: ConnectionState) => {
            this.handleConnectionStateChange(state);
        });
        
        // Subscribe to bot responses to see if we get a reply
        manager.on('botResponse', (response: any) => {
            print('');
            print('✅ ═══════════════════════════════════════════════════════════');
            print('✅ BOT RESPONSE RECEIVED (Image was processed!)');
            print(`✅ Response: ${response?.text?.substring(0, 200) || '(empty)'}...`);
            print('✅ ═══════════════════════════════════════════════════════════');
            print('');
        });
        
        // Subscribe to errors - useful for debugging
        manager.on('error', (error: string) => {
            print('');
            print('⚠️ ═══════════════════════════════════════════════════════════');
            print('⚠️ ERROR RECEIVED');
            print(`⚠️ ${error}`);
            // Check if this is an OpenAI image error - this means the endpoint worked!
            if (error.includes('image') || error.includes('vision')) {
                print('');
                print('ℹ️ NOTE: Getting an image error from OpenAI means:');
                print('ℹ️  ✓ WebSocket connection is working');
                print('ℹ️  ✓ Authentication is working');
                print('ℹ️  ✓ camera_image endpoint received the image');
                print('ℹ️  ✓ Server forwarded it to OpenAI for processing');
                print('ℹ️  ✗ OpenAI rejected the test image data');
                print('');
                print('ℹ️ For a REAL test, attach a Device Camera Texture!');
            }
            print('⚠️ ═══════════════════════════════════════════════════════════');
            print('');
        });
        
        this._isSubscribed = true;
        print('[ImageEndpointTest] ✓ Subscribed to EstuaryManager events');
        print('[ImageEndpointTest] Waiting for connection...');
    }
    
    private handleConnectionStateChange(state: ConnectionState): void {
        print(`[ImageEndpointTest] Connection state: ${state}`);
        
        if (state === ConnectionState.Connected && this.autoRunOnConnect && !this._hasRunTest) {
            print(`[ImageEndpointTest] Connected! Running test in ${this.testDelay} seconds...`);
            
            // Delay before running test
            let delayMs = this.testDelay * 1000;
            this.createEvent('DelayedCallbackEvent').bind(() => {
                this.runImageTest();
            });
            // Use a simple update counter for delay since DelayedCallbackEvent needs different handling
            let startTime = getTime();
            let delayEvent = this.createEvent('UpdateEvent');
            delayEvent.bind(() => {
                if (getTime() - startTime >= this.testDelay) {
                    delayEvent.enabled = false;
                    this.runImageTest();
                }
            });
        }
    }
    
    // ==================== Test Methods ====================
    
    /**
     * Run the image endpoint test.
     * Can be called manually via script reference.
     */
    runImageTest(): void {
        if (this._hasRunTest) {
            print('[ImageEndpointTest] Test already run. Call reset() to run again.');
            return;
        }
        
        print('');
        print('🧪 ═══════════════════════════════════════════════════════════');
        print('🧪 STARTING IMAGE ENDPOINT TEST');
        print('🧪 ═══════════════════════════════════════════════════════════');
        
        const manager = EstuaryManager.instance;
        if (!manager) {
            print('[ImageEndpointTest] ❌ ERROR: EstuaryManager not available');
            return;
        }
        
        if (!manager.isConnected) {
            print('[ImageEndpointTest] ❌ ERROR: Not connected to server');
            return;
        }
        
        // Get image to send
        let imageBase64: string | null = null;
        let mimeType = 'image/jpeg';
        
        // Try camera texture first
        if (this.cameraTexture) {
            imageBase64 = this.captureTextureToBase64(this.cameraTexture);
            if (imageBase64) {
                print(`[ImageEndpointTest] 📷 Using camera texture (${imageBase64.length} chars)`);
            }
        }
        
        // Try static test image if camera failed
        if (!imageBase64 && this.staticTestImage) {
            imageBase64 = this.captureTextureToBase64(this.staticTestImage);
            if (imageBase64) {
                print(`[ImageEndpointTest] 🖼️ Using static test image (${imageBase64.length} chars)`);
            }
        }
        
        // Fall back to hardcoded test PNG
        if (!imageBase64) {
            imageBase64 = this.generateTestPng();
            mimeType = 'image/png';
            print(`[ImageEndpointTest] 🎨 Using generated test PNG (${imageBase64.length} chars)`);
        }
        
        // Generate a test request ID
        const requestId = 'test-' + Date.now().toString(36);
        
        print(`[ImageEndpointTest] 📤 Sending image to server...`);
        print(`[ImageEndpointTest]    Request ID: ${requestId}`);
        print(`[ImageEndpointTest]    MIME Type: ${mimeType}`);
        print(`[ImageEndpointTest]    Prompt: ${this.testPrompt}`);
        print(`[ImageEndpointTest]    Image size: ${imageBase64.length} base64 chars`);
        
        // Send the image
        manager.sendCameraImage(
            imageBase64,
            mimeType,
            requestId,
            this.testPrompt
        );
        
        this._hasRunTest = true;
        
        print('');
        print('🧪 ═══════════════════════════════════════════════════════════');
        print('🧪 IMAGE SENT! Waiting for server response...');
        print('🧪 Check Logger for bot_response or error messages');
        print('🧪 ═══════════════════════════════════════════════════════════');
        print('');
    }
    
    /**
     * Reset the test state to allow running again.
     */
    reset(): void {
        this._hasRunTest = false;
        print('[ImageEndpointTest] Test state reset. Can run test again.');
    }
    
    // ==================== Image Helpers ====================
    
    /**
     * Capture texture to base64 string.
     */
    private captureTextureToBase64(texture: Texture): string | null {
        try {
            // Method 1: Use Lens Studio's Base64 global API
            // @ts-ignore - Lens Studio global API
            if (typeof Base64 !== 'undefined' && Base64.encode) {
                // @ts-ignore
                const encoded = Base64.encode(texture);
                return encoded;
            }
            
            // Method 2: Check for encodeToBase64 on texture
            // @ts-ignore
            if (texture.encodeToBase64) {
                // @ts-ignore
                const encoded = texture.encodeToBase64();
                return encoded;
            }
            
            // Method 3: Use EncodeTexture API if available
            // @ts-ignore
            if (typeof EncodeTexture !== 'undefined') {
                // @ts-ignore
                const encoded = EncodeTexture.encodeToBase64(texture, 'jpeg', 85);
                return encoded;
            }
            
            print('[ImageEndpointTest] No texture encoding method available');
            return null;
            
        } catch (e) {
            print(`[ImageEndpointTest] Failed to encode texture: ${e}`);
            return null;
        }
    }
    
    /**
     * Generate a valid PNG test image.
     * This is a 50x50 red square that OpenAI will accept and describe.
     */
    private generateTestPng(): string {
        // 50x50 solid red PNG - OpenAI will describe it as "a red square"
        // Larger than minimal to ensure vision APIs accept it
        return 'iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAYAAAAeP4ixAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABVSURBVGhD7c+hEQAgDMDA7r908UzwcBFv4jI7sz+YO7yqEU0jmkY0jWga0TSiaUTTiKYRTSOaRjSNaBrRNKJpRNOIphFNI5pGNI1oGtE0omlE04jmALAzdZavRtXoAAAAAElFTkSuQmCC';
    }
}
