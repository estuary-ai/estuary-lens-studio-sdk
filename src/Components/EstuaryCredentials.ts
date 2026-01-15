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
 * User ID Management:
 * - User ID is persisted on-device using PersistentStorageSystem
 * - If a User ID is entered in the "User ID" field, it will be used and stored
 * - If the User ID field is empty, the stored User ID will be loaded from device storage
 * - If no stored User ID exists, a new one will be generated and stored
 * - This allows conversation persistence across Lens sessions on the same device
 */

/** Storage key for persistent user ID */
const USER_ID_STORAGE_KEY = "estuary_user_id";

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
    /** The user ID for conversation persistence (manual or auto-generated) */
    userId: string;
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
    
    /** 
     * Enable debug logging for all Estuary components.
     */
    @input
    @hint("Enable debug logging for all Estuary components")
    debugMode: boolean = true;
    
    // ==================== User ID Configuration ====================
    
    /**
     * User ID field.
     * If provided, this User ID will be used and stored for future sessions.
     * If empty, the stored User ID will be loaded from device storage.
     * Use this to test with a specific User ID or resume a conversation.
     */
    @input
    @hint("Enter a User ID to use (will be stored), or leave empty to use stored/generated ID")
    @allowUndefined
    userIdField: string = "";
    
    /** The resolved user ID (either manual or auto-generated) */
    private _resolvedUserId: string = "";
    
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
    
    // ==================== User ID Property ====================
    
    /**
     * Get the resolved user ID.
     * Returns the userIdField value if provided, otherwise a randomly generated ID.
     */
    get userId(): string {
        return this._resolvedUserId;
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
     * Priority: userIdField (if provided) > stored User ID > generate new
     * If userIdField is provided, it will be stored for future sessions.
     */
    private initializeUserId(): void {
        const store = global.persistentStorageSystem.store;
        
        // Priority 1: Use User ID from field if provided (and store it)
        // Trim whitespace to handle copy-paste issues
        const trimmedUserIdField = this.userIdField ? this.userIdField.trim() : '';
        if (trimmedUserIdField.length > 0) {
            this._resolvedUserId = trimmedUserIdField;
            // Store the manual User ID for future sessions
            store.putString(USER_ID_STORAGE_KEY, this._resolvedUserId);
            this.log(`Using User ID from field: ${this._resolvedUserId}`);
            this.log(`Stored User ID in persistent storage`);
            this.printUserIdBanner();
            return;
        }
        
        // Priority 2: Try to load stored User ID from device
        if (store.has(USER_ID_STORAGE_KEY)) {
            const storedId = store.getString(USER_ID_STORAGE_KEY);
            // Trim stored value as well
            const trimmedStoredId = storedId ? storedId.trim() : '';
            if (trimmedStoredId.length > 0) {
                this._resolvedUserId = trimmedStoredId;
                this.log(`Loaded User ID from persistent storage: ${this._resolvedUserId}`);
                this.printUserIdBanner();
                return;
            }
        }
        
        // Priority 3: Generate new User ID and store it
        this._resolvedUserId = this.generateRandomUserId();
        store.putString(USER_ID_STORAGE_KEY, this._resolvedUserId);
        this.log(`Generated new User ID: ${this._resolvedUserId}`);
        this.log(`Stored User ID in persistent storage`);
        this.printUserIdBanner();
    }
    
    /**
     * Print the current User ID prominently to the Logger.
     */
    private printUserIdBanner(): void {
        print("╔════════════════════════════════════════════════════════════╗");
        print("║  ESTUARY USER ID: " + this._resolvedUserId.padEnd(41) + "║");
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
            const source = this.userIdField && this.userIdField.length > 0 
                ? 'manual (from field)' 
                : 'persistent storage';
            this.log(`   User ID source: ${source}`);
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
