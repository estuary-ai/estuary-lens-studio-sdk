/**
 * EstuaryCredentials - Central configuration component for Estuary SDK credentials.
 * 
 * This component provides a single place to configure your Estuary API key and character ID.
 * Other components (SimpleAutoConnect, EstuaryActionManager, etc.) can reference this
 * component to access the credentials.
 * 
 * Setup in Lens Studio:
 * 1. Create a SceneObject (e.g., "Estuary Credentials")
 * 2. Add this script to the SceneObject
 * 3. Set your API key and Character ID in the Inspector
 * 4. Reference this SceneObject from other Estuary components
 * 
 * User ID Management (Priority Order):
 * 1. Snap Account User ID - Uses userContextSystem to get the Snapchat account's user ID
 *    This ID is tied to the user's Snapchat account and persists across devices
 * 2. Manual User ID - If entered in the inspector field, will be used and stored
 * 3. Stored User ID - Loaded from device persistent storage
 * 4. Generated User ID - A new random ID is generated and stored
 * 
 * The Snap Account User ID is the preferred method for conversation persistence as it:
 * - Remains consistent when the same user logs in on different devices
 * - Automatically identifies the user without manual configuration
 * - Works across Lens sessions on the same Snapchat account
 */

/** Storage key for persistent user ID (fallback when Snap ID unavailable) */
const USER_ID_STORAGE_KEY = "estuary_user_id";

/** Storage key for caching the Snap account user ID */
const SNAP_USER_ID_CACHE_KEY = "estuary_snap_user_id";

/**
 * Interface for accessing EstuaryCredentials from other scripts.
 * Use this when referencing the credentials component.
 */
export interface IEstuaryCredentials {
    /** The API key from your Estuary dashboard */
    apiKey: string;
    /** The character/agent ID from your Estuary dashboard */
    characterId: string;
    /** The Estuary server URL */
    serverUrl: string;
    /** Enable debug logging across all Estuary components */
    debugMode: boolean;
    /** The user ID for conversation persistence (from Snap account, manual input, or auto-generated) */
    userId: string;
    /** Whether we're using Snap account-based user ID (cross-device persistence) */
    isUsingSnapAccountId?: boolean;
}

/**
 * EstuaryCredentials - Lens Studio component for centralized credential management.
 * 
 * Add this to a SceneObject and configure your credentials once.
 * Other Estuary components can reference this object to access the credentials.
 */
@component
export class EstuaryCredentials extends BaseScriptComponent implements IEstuaryCredentials {
    
    // ==================== Configuration (set in Inspector) ====================
    
    /** 
     * Your Estuary API key.
     * Generate this from your Estuary dashboard.
     */
    @input
    @hint("Your API key from the Estuary dashboard")
    apiKey: string = "";
    
    /** 
     * The character/agent ID to connect to.
     * Get this from your Estuary dashboard.
     */
    @input
    @hint("Character/Agent ID from your Estuary dashboard")
    characterId: string = "";
    
    /** 
     * The Estuary server URL.
     * Default: wss://api.estuary-ai.com
     */
    // @input
    // @hint("Estuary server URL (default: wss://api.estuary-ai.com)")
    serverUrl: string = "wss://api.estuary-ai.com";
    
    // ==================== User ID Configuration ====================
    
    /**
     * Enable Snap Account-based User ID.
     * When enabled, uses the Snapchat account's user ID for conversation persistence.
     * This ID is consistent across all devices logged into the same Snapchat account.
     * Recommended for production use.
     */
    @input
    @hint("Use Snapchat account ID for cross-device conversation persistence (recommended)")
    useSnapAccountId: boolean = true;
    
    /**
     * User ID field (override).
     * If provided, this User ID will be used instead of the Snap account ID.
     * Useful for testing with a specific User ID or debugging.
     * Leave empty to use automatic Snap account-based or generated ID.
     */
    @input
    @hint("Override: Enter a specific User ID (leave empty to use Snap account ID)")
    @allowUndefined
    userIdField: string = "";

    /** 
     * Enable debug logging for all Estuary components.
     */
    @input
    @hint("Enable debug logging for all Estuary components")
    debugMode: boolean = true;
    
    /** The resolved user ID (from Snap account, manual input, or auto-generated) */
    private _resolvedUserId: string = "";
    
    /** Whether we successfully retrieved the Snap account ID */
    private _usingSnapAccountId: boolean = false;
    
    // ==================== Singleton Access ====================
    
    private static _instance: EstuaryCredentials | null = null;
    
    /**
     * Get the singleton instance of EstuaryCredentials.
     * Returns null if no instance has been created yet.
     */
    static get instance(): EstuaryCredentials | null {
        return EstuaryCredentials._instance;
    }
    
    /**
     * Check if an instance exists.
     */
    static get hasInstance(): boolean {
        return EstuaryCredentials._instance !== null;
    }
    
    // ==================== User ID Properties ====================
    
    /**
     * Get the resolved user ID.
     * Returns the Snap account ID, userIdField value, stored ID, or a generated ID.
     */
    get userId(): string {
        return this._resolvedUserId;
    }
    
    /**
     * Check if we're using Snap account-based user ID.
     * When true, the user ID is tied to the Snapchat account and
     * conversations will persist across all devices on the same account.
     */
    get isUsingSnapAccountId(): boolean {
        return this._usingSnapAccountId;
    }
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        // Register as singleton
        if (EstuaryCredentials._instance === null) {
            EstuaryCredentials._instance = this;
            this.log("EstuaryCredentials initialized as singleton");
        } else {
            print("[EstuaryCredentials] WARNING: Multiple EstuaryCredentials instances detected. Using the first one.");
        }
        
        // Initialize user ID
        this.initializeUserId();
        
        // Validate credentials
        this.validateCredentials();
    }
    
    onDestroy() {
        if (EstuaryCredentials._instance === this) {
            EstuaryCredentials._instance = null;
        }
    }
    
    // ==================== User ID Management ====================
    
    /**
     * Initialize the user ID based on configuration.
     * Priority: 
     * 1. Manual userIdField (if provided) - for testing/debugging
     * 2. Snap Account User ID (if useSnapAccountId is enabled) - for production
     * 3. Cached Snap User ID (from previous session)
     * 4. Stored User ID from device storage
     * 5. Generate new random User ID
     */
    private initializeUserId(): void {
        const store = global.persistentStorageSystem.store;
        
        // Priority 1: Use User ID from field if provided (manual override)
        // Trim whitespace to handle copy-paste issues
        const trimmedUserIdField = this.userIdField ? this.userIdField.trim() : '';
        if (trimmedUserIdField.length > 0) {
            this._resolvedUserId = trimmedUserIdField;
            this._usingSnapAccountId = false;
            // Store the manual User ID for future sessions
            store.putString(USER_ID_STORAGE_KEY, this._resolvedUserId);
            this.log(`Using MANUAL User ID from field: ${this._resolvedUserId}`);
            this.printUserIdBanner("manual override");
            return;
        }
        
        // Priority 2: Try to get Snap Account User ID (if enabled)
        if (this.useSnapAccountId) {
            const snapUserId = this.getSnapAccountUserId();
            if (snapUserId && snapUserId.length > 0) {
                this._resolvedUserId = snapUserId;
                this._usingSnapAccountId = true;
                // Cache the Snap User ID for faster access next session
                store.putString(SNAP_USER_ID_CACHE_KEY, this._resolvedUserId);
                this.log(`Using SNAP ACCOUNT User ID: ${this._resolvedUserId}`);
                this.printUserIdBanner("Snap account");
                return;
            }
            
            // Priority 3: Try to use cached Snap User ID from previous session
            if (store.has(SNAP_USER_ID_CACHE_KEY)) {
                const cachedSnapId = store.getString(SNAP_USER_ID_CACHE_KEY);
                const trimmedCachedId = cachedSnapId ? cachedSnapId.trim() : '';
                if (trimmedCachedId.length > 0) {
                    this._resolvedUserId = trimmedCachedId;
                    this._usingSnapAccountId = true;
                    this.log(`Using CACHED Snap Account User ID: ${this._resolvedUserId}`);
                    this.printUserIdBanner("cached Snap account");
                    return;
                }
            }
            
            this.log("Snap Account User ID not available, falling back to device storage...");
        }
        
        // Priority 4: Try to load stored User ID from device
        if (store.has(USER_ID_STORAGE_KEY)) {
            const storedId = store.getString(USER_ID_STORAGE_KEY);
            // Trim stored value as well
            const trimmedStoredId = storedId ? storedId.trim() : '';
            if (trimmedStoredId.length > 0) {
                this._resolvedUserId = trimmedStoredId;
                this._usingSnapAccountId = false;
                this.log(`Loaded User ID from persistent storage: ${this._resolvedUserId}`);
                this.printUserIdBanner("device storage");
                return;
            }
        }
        
        // Priority 5: Generate new User ID and store it
        this._resolvedUserId = this.generateRandomUserId();
        this._usingSnapAccountId = false;
        store.putString(USER_ID_STORAGE_KEY, this._resolvedUserId);
        this.log(`Generated new User ID: ${this._resolvedUserId}`);
        this.log(`Stored User ID in persistent storage`);
        this.printUserIdBanner("generated");
    }
    
    /**
     * Get the Snap account user ID using userContextSystem synchronously.
     * Uses the displayName which is available synchronously.
     * 
     * Note: displayName may change if the user changes their username,
     * but it's still reliable for most use cases and is tied to the Snapchat account.
     * 
     * @returns The Snap account user ID, or null if not available
     */
    private getSnapAccountUserId(): string | null {
        try {
            // Access Snap's userContextSystem to get current user info
            // This is available in Lens Studio via the global object
            const userContextSystem = global.userContextSystem;
            
            if (!userContextSystem) {
                this.log("userContextSystem not available");
                return null;
            }
            
            // Try to get display name synchronously first
            // displayName is available on the userContextSystem directly in some versions
            let displayName: string | null = null;
            
            // Check if displayName is directly accessible
            if (typeof (userContextSystem as any).displayName === 'string') {
                displayName = (userContextSystem as any).displayName;
            }
            
            // If we got a display name, use it to create a stable user ID
            if (displayName && displayName.length > 0) {
                this.log(`Got displayName from userContextSystem: ${displayName}`);
                // Create a stable hash from display name with spectacles_ prefix
                // Format matches the original: spectacles_ + identifier
                return `spectacles_${this.hashString(displayName)}`;
            }
            
            // Try requestDisplayName with callback for async retrieval
            // This will update the cached ID for next session
            this.requestSnapUserIdAsync();
            
            return null;
        } catch (error) {
            this.log(`Error getting Snap account user ID: ${error}`);
            return null;
        }
    }
    
    /**
     * Asynchronously request the Snap user display name and cache it for future sessions.
     * This uses the callback-based API of userContextSystem.
     */
    private requestSnapUserIdAsync(): void {
        try {
            const userContextSystem = global.userContextSystem;
            if (!userContextSystem) {
                return;
            }
            
            // requestDisplayName uses a callback pattern
            if (typeof userContextSystem.requestDisplayName === 'function') {
                userContextSystem.requestDisplayName((displayName: string) => {
                    if (displayName && displayName.length > 0) {
                        // Format: spectacles_ + hash of displayName (consistent per account)
                        const snapUserId = `spectacles_${this.hashString(displayName)}`;
                        const store = global.persistentStorageSystem.store;
                        
                        // Cache this for next session
                        store.putString(SNAP_USER_ID_CACHE_KEY, snapUserId);
                        this.log(`Async: Cached Snap user ID for next session: ${snapUserId}`);
                        
                        // If we're not yet using a Snap account ID, update to use it
                        // Check if current ID looks like a timestamp-based generated ID (longer format)
                        if (!this._usingSnapAccountId) {
                            this._resolvedUserId = snapUserId;
                            this._usingSnapAccountId = true;
                            store.putString(USER_ID_STORAGE_KEY, snapUserId);
                            this.log(`Async: Updated current session to use Snap user ID: ${snapUserId}`);
                            this.printUserIdBanner("Snap account (async)");
                        }
                    }
                });
            }
        } catch (error) {
            this.log(`Error in async Snap user ID request: ${error}`);
        }
    }
    
    /**
     * Simple string hash function for creating stable IDs from display names.
     * @param str The string to hash
     * @returns A numeric hash as a string
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }
    
    /**
     * Print the current User ID prominently to the Logger.
     * @param source Description of where the User ID came from
     */
    private printUserIdBanner(source: string): void {
        print("╔════════════════════════════════════════════════════════════╗");
        print("║  ESTUARY USER ID                                           ║");
        print("║  " + this._resolvedUserId.padEnd(58) + "║");
        print("║  Source: " + source.padEnd(50) + "║");
        if (this._usingSnapAccountId) {
            print("║  ✓ Cross-device persistence enabled (Snap account)        ║");
        }
        print("╚════════════════════════════════════════════════════════════╝");
    }
    
    /**
     * Generate a random unique User ID.
     * Format: "spectacles_" + timestamp in base36
     */
    private generateRandomUserId(): string {
        return "spectacles_" + Date.now().toString(36);
    }
    
    // ==================== Validation ====================
    
    /**
     * Validate that credentials are configured.
     * @returns True if credentials are valid
     */
    validateCredentials(): boolean {
        let isValid = true;
        
        if (!this.apiKey || this.apiKey.length === 0 || this.apiKey === "[ESTUARY_API_KEY]") {
            print("[EstuaryCredentials] ⚠️ WARNING: API key is not configured!");
            isValid = false;
        }
        
        if (!this.characterId || this.characterId.length === 0 || this.characterId === "[ESTUARY_CHARACTER_ID]") {
            print("[EstuaryCredentials] ⚠️ WARNING: Character ID is not configured!");
            isValid = false;
        }
        
        if (!this._resolvedUserId || this._resolvedUserId.length === 0) {
            print("[EstuaryCredentials] ⚠️ WARNING: User ID could not be resolved!");
            isValid = false;
        }
        
        if (isValid) {
            this.log("✅ Credentials configured successfully");
            this.log(`   User ID: ${this._resolvedUserId}`);
            let source: string;
            if (this.userIdField && this.userIdField.trim().length > 0) {
                source = 'manual (from inspector field)';
            } else if (this._usingSnapAccountId) {
                source = 'Snap account (cross-device)';
            } else {
                source = 'device storage (device-specific)';
            }
            this.log(`   User ID source: ${source}`);
            if (this._usingSnapAccountId) {
                this.log(`   ✓ Conversation will persist across all devices on this Snap account`);
            }
        }
        
        return isValid;
    }
    
    // ==================== Utility ====================
    
    private log(message: string): void {
        if (this.debugMode) {
            print(`[EstuaryCredentials] ${message}`);
        }
    }
}

/**
 * Helper function to get credentials from a SceneObject.
 * @param sceneObject The SceneObject containing EstuaryCredentials
 * @returns The credentials interface or null if not found
 */
export function getCredentialsFromSceneObject(sceneObject: SceneObject | null): IEstuaryCredentials | null {
    if (!sceneObject) {
        return null;
    }
    
    const componentCount = sceneObject.getComponentCount("Component.ScriptComponent");
    for (let i = 0; i < componentCount; i++) {
        const scriptComp = sceneObject.getComponentByIndex("Component.ScriptComponent", i) as any;
        if (scriptComp && 
            typeof scriptComp.apiKey === 'string' && 
            typeof scriptComp.characterId === 'string' &&
            typeof scriptComp.serverUrl === 'string') {
            return scriptComp as IEstuaryCredentials;
        }
    }
    
    return null;
}
