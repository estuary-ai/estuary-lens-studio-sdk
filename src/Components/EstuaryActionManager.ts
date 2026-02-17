/**
 * Action Manager component for Estuary SDK in Lens Studio.
 * Parses action tags from bot responses and tracks triggered actions.
 * 
 * Usage:
 * 1. Create an instance: const actionManager = new EstuaryActionManager(character);
 * 2. Subscribe to events: actionManager.on('actionTriggered', (action) => { ... });
 * 3. Check current action: const currentAction = actionManager.currentAction;
 */

import { EstuaryCharacter } from './EstuaryCharacter';
import { EstuaryCredentials, IEstuaryCredentials, getCredentialsFromSceneObject } from './EstuaryCredentials';
import { BotResponse } from '../Models/BotResponse';
import { EventEmitter } from '../Core/EstuaryEvents';

/**
 * Event types for EstuaryActionManager
 */
export interface EstuaryActionManagerEvents {
    /** Fired when an action is detected in a bot response */
    actionTriggered: (action: ParsedAction) => void;
    /** Fired when action parsing completes for a message */
    actionsParsed: (actions: ParsedAction[]) => void;
    /** Fired for specific action names: 'action:sit', 'action:wave', etc. */
    [key: `action:${string}`]: (action: ParsedAction) => void;
}

/**
 * Registered action definition for a character
 */
export interface RegisteredAction {
    /** The action name (e.g., "sit", "wave") */
    name: string;
    /** Optional description of what the action does */
    description?: string;
    /** Whether the action is currently enabled */
    enabled: boolean;
}

/**
 * Represents a parsed action from bot response text
 */
export interface ParsedAction {
    /** The action name (e.g., "sit", "wave", "dance") */
    name: string;
    /** The full original tag text */
    tag: string;
    /** The message ID this action came from */
    messageId: string;
    /** Timestamp when action was detected */
    timestamp: number;
}

/**
 * EstuaryActionManager - Parses and tracks actions from bot responses.
 * 
 * Monitors bot responses for action tags like <action name="sit" /> and
 * emits events when actions are detected. Also tracks the current/last action.
 */
export class EstuaryActionManager extends EventEmitter<any> {
    
    // ==================== Configuration ====================
    
    /** Debug logging enabled */
    private _debugLogging: boolean = false;
    
    /** Whether to only parse actions from final responses (not streaming chunks) */
    private _onlyFinalResponses: boolean = true;
    
    // ==================== State ====================
    
    /** The most recently triggered action */
    private _currentAction: ParsedAction | null = null;
    
    /** All actions triggered in the current session */
    private _actionHistory: ParsedAction[] = [];
    
    /** Maximum number of actions to keep in history */
    private _maxHistorySize: number = 100;
    
    /** Regex pattern to match action tags: <action name="..." /> */
    private readonly _actionTagRegex: RegExp = /<action\s+name\s*=\s*["']([^"']+)["']\s*\/?>/gi;
    
    /** Registered actions per character ID */
    private _registeredActions: Map<string, Map<string, RegisteredAction>> = new Map();
    
    /** Whether to only trigger registered actions (false = trigger all actions) */
    private _strictMode: boolean = false;
    
    // ==================== References ====================
    
    /** Target character to monitor for bot responses */
    private _targetCharacter: EstuaryCharacter | null = null;
    
    /** Whether currently listening to bot responses */
    private _isListening: boolean = false;
    
    /** Handler function for botResponse events (stored for cleanup) */
    private _botResponseHandler: ((response: BotResponse) => void) | null = null;
    
    // ==================== Constructor ====================
    
    constructor(targetCharacter?: EstuaryCharacter) {
        super();
        if (targetCharacter) {
            this.setTargetCharacter(targetCharacter);
        }
    }
    
    // ==================== Properties ====================
    
    /** Get the most recently triggered action */
    get currentAction(): ParsedAction | null {
        return this._currentAction;
    }
    
    /** Get all actions triggered in the current session */
    get actionHistory(): ReadonlyArray<ParsedAction> {
        return this._actionHistory;
    }
    
    /** Whether currently listening to bot responses */
    get isListening(): boolean {
        return this._isListening;
    }
    
    /** Enable or disable debug logging */
    get debugLogging(): boolean {
        return this._debugLogging;
    }
    
    set debugLogging(value: boolean) {
        this._debugLogging = value;
    }
    
    /** Whether to only parse actions from final responses */
    get onlyFinalResponses(): boolean {
        return this._onlyFinalResponses;
    }
    
    set onlyFinalResponses(value: boolean) {
        this._onlyFinalResponses = value;
    }
    
    /** Maximum number of actions to keep in history */
    get maxHistorySize(): number {
        return this._maxHistorySize;
    }
    
    set maxHistorySize(value: number) {
        this._maxHistorySize = value;
        // Trim history if needed
        if (this._actionHistory.length > this._maxHistorySize) {
            this._actionHistory = this._actionHistory.slice(-this._maxHistorySize);
        }
    }
    
    /** 
     * Whether to only trigger registered actions.
     * If true, unregistered actions will be ignored.
     * If false (default), all actions will be triggered.
     */
    get strictMode(): boolean {
        return this._strictMode;
    }
    
    set strictMode(value: boolean) {
        this._strictMode = value;
    }
    
    // ==================== Action Registration ====================
    
    /**
     * Register an action for a character.
     * @param characterId The character ID (or '*' for all characters)
     * @param actionName The action name to register
     * @param description Optional description of the action
     */
    registerAction(characterId: string, actionName: string, description?: string): void {
        const charId = characterId || '*';
        
        if (!this._registeredActions.has(charId)) {
            this._registeredActions.set(charId, new Map());
        }
        
        const actions = this._registeredActions.get(charId)!;
        actions.set(actionName.toLowerCase(), {
            name: actionName,
            description: description,
            enabled: true
        });
        
        this.log(`Registered action '${actionName}' for character '${charId}'`);
    }
    
    /**
     * Register multiple actions for a character.
     * @param characterId The character ID (or '*' for all characters)
     * @param actionNames Array of action names to register
     */
    registerActions(characterId: string, actionNames: string[]): void {
        for (const name of actionNames) {
            this.registerAction(characterId, name);
        }
    }
    
    /**
     * Unregister an action for a character.
     * @param characterId The character ID
     * @param actionName The action name to unregister
     */
    unregisterAction(characterId: string, actionName: string): void {
        const charId = characterId || '*';
        const actions = this._registeredActions.get(charId);
        if (actions) {
            actions.delete(actionName.toLowerCase());
            this.log(`Unregistered action '${actionName}' for character '${charId}'`);
        }
    }
    
    /**
     * Check if an action is registered for a character.
     * @param characterId The character ID
     * @param actionName The action name
     * @returns True if the action is registered
     */
    isActionRegistered(characterId: string, actionName: string): boolean {
        const lowerName = actionName.toLowerCase();
        
        // Check character-specific actions
        const charActions = this._registeredActions.get(characterId);
        if (charActions?.has(lowerName)) {
            return true;
        }
        
        // Check global actions (registered for '*')
        const globalActions = this._registeredActions.get('*');
        if (globalActions?.has(lowerName)) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Get all registered actions for a character.
     * @param characterId The character ID
     * @returns Array of registered action names
     */
    getRegisteredActions(characterId: string): string[] {
        const actions: string[] = [];
        
        // Add character-specific actions
        const charActions = this._registeredActions.get(characterId);
        if (charActions) {
            charActions.forEach((_, name) => actions.push(name));
        }
        
        // Add global actions
        const globalActions = this._registeredActions.get('*');
        if (globalActions) {
            globalActions.forEach((_, name) => {
                if (!actions.includes(name)) {
                    actions.push(name);
                }
            });
        }
        
        return actions;
    }
    
    /**
     * Enable or disable a registered action.
     * @param characterId The character ID
     * @param actionName The action name
     * @param enabled Whether the action is enabled
     */
    setActionEnabled(characterId: string, actionName: string, enabled: boolean): void {
        const lowerName = actionName.toLowerCase();
        
        const charActions = this._registeredActions.get(characterId);
        if (charActions?.has(lowerName)) {
            charActions.get(lowerName)!.enabled = enabled;
        }
        
        const globalActions = this._registeredActions.get('*');
        if (globalActions?.has(lowerName)) {
            globalActions.get(lowerName)!.enabled = enabled;
        }
    }
    
    // ==================== Action Event Subscription ====================
    
    /**
     * Subscribe to a specific action event.
     * This is the primary way for external scripts to listen for actions.
     * 
     * @param actionName The action name to listen for (e.g., 'sit', 'wave')
     * @param handler The callback function when the action is triggered
     * @returns A function to unsubscribe
     * 
     * @example
     * const unsubscribe = actionManager.onAction('sit', (action) => {
     *     print('Character is sitting!');
     *     playAnimation('sit');
     * });
     * 
     * // Later, to stop listening:
     * unsubscribe();
     */
    onAction(actionName: string, handler: (action: ParsedAction) => void): () => void {
        const lowerName = actionName.toLowerCase();
        const eventName = `action:${lowerName}`;
        
        this.on(eventName, handler);
        this.log(`Subscribed to action '${actionName}'`);
        
        // Return unsubscribe function
        return () => {
            this.off(eventName, handler);
            this.log(`Unsubscribed from action '${actionName}'`);
        };
    }
    
    /**
     * Subscribe to multiple actions at once.
     * @param actionNames Array of action names to listen for
     * @param handler The callback function
     * @returns A function to unsubscribe from all
     */
    onActions(actionNames: string[], handler: (action: ParsedAction) => void): () => void {
        const unsubscribes = actionNames.map(name => this.onAction(name, handler));
        
        return () => {
            unsubscribes.forEach(unsub => unsub());
        };
    }
    
    /**
     * Subscribe to all actions.
     * @param handler The callback function
     * @returns A function to unsubscribe
     */
    onAnyAction(handler: (action: ParsedAction) => void): () => void {
        this.on('actionTriggered', handler);
        this.log('Subscribed to all actions');
        
        return () => {
            this.off('actionTriggered', handler);
            this.log('Unsubscribed from all actions');
        };
    }
    
    // ==================== Public Methods ====================
    
    /**
     * Set credentials from a SceneObject containing EstuaryCredentials.
     * Only used to sync debug logging mode.
     * @param sceneObject The SceneObject with EstuaryCredentials script
     * @returns True if credentials were found
     */
    setCredentialsFromSceneObject(sceneObject: SceneObject | null): boolean {
        if (!sceneObject) {
            return false;
        }
        
        const creds = getCredentialsFromSceneObject(sceneObject);
        if (creds) {
            this._debugLogging = creds.debugMode;
            this.log('Credentials found from SceneObject');
            return true;
        }
        
        return false;
    }
    
    /**
     * Set credentials from the EstuaryCredentials singleton.
     * Only used to sync debug logging mode.
     * @returns True if credentials were found
     */
    setCredentialsFromSingleton(): boolean {
        if (EstuaryCredentials.hasInstance && EstuaryCredentials.instance) {
            this._debugLogging = EstuaryCredentials.instance.debugMode;
            this.log('Credentials found from singleton');
            return true;
        }
        
        return false;
    }
    
    /**
     * Set credentials directly.
     * Only used to sync debug logging mode.
     * @param credentials The credentials to use
     */
    setCredentials(credentials: IEstuaryCredentials): void {
        this._debugLogging = credentials.debugMode;
        this.log('Credentials set directly');
    }
    
    /**
     * Set the target character to monitor for bot responses.
     * @param character The EstuaryCharacter to monitor
     */
    setTargetCharacter(character: EstuaryCharacter | null): void {
        // Stop listening to previous character if any
        if (this._targetCharacter && this._isListening) {
            this.stopListening();
        }
        
        this._targetCharacter = character;
        
        // Auto-start listening if character is set
        if (character && !this._isListening) {
            this.startListening();
        }
    }
    
    /**
     * Start listening to bot responses from the target character.
     */
    startListening(): void {
        if (this._isListening) {
            this.log('Already listening to bot responses');
            return;
        }
        
        if (!this._targetCharacter) {
            this.logError('Cannot start listening: No target character set');
            return;
        }
        
        // Create and store handler function
        this._botResponseHandler = (response: BotResponse) => {
            this.handleBotResponse(response);
        };
        
        // Subscribe to botResponse events
        this._targetCharacter.on('botResponse', this._botResponseHandler);
        
        this._isListening = true;
        this.log('Started listening to bot responses');
    }
    
    /**
     * Stop listening to bot responses.
     */
    stopListening(): void {
        if (!this._isListening) {
            return;
        }
        
        if (this._targetCharacter && this._botResponseHandler) {
            this._targetCharacter.off('botResponse', this._botResponseHandler);
            this._botResponseHandler = null;
        }
        
        this._isListening = false;
        this.log('Stopped listening to bot responses');
    }
    
    /**
     * Clear the action history and reset current action.
     */
    clearHistory(): void {
        this._actionHistory = [];
        this._currentAction = null;
        this.log('Action history cleared');
    }
    
    /**
     * Check if a specific action was triggered recently.
     * @param actionName The action name to check for
     * @param withinLastMs Optional: only check actions within this time window (ms)
     * @returns True if the action was triggered
     */
    wasActionTriggered(actionName: string, withinLastMs?: number): boolean {
        if (!this._currentAction) {
            return false;
        }
        
        if (this._currentAction.name.toLowerCase() !== actionName.toLowerCase()) {
            return false;
        }
        
        if (withinLastMs !== undefined) {
            const now = Date.now();
            const age = now - this._currentAction.timestamp;
            return age <= withinLastMs;
        }
        
        return true;
    }
    
    /**
     * Get all actions with a specific name from history.
     * @param actionName The action name to search for
     * @returns Array of matching actions
     */
    getActionsByName(actionName: string): ParsedAction[] {
        return this._actionHistory.filter(
            action => action.name.toLowerCase() === actionName.toLowerCase()
        );
    }
    
    /**
     * Dispose of the manager and release resources.
     */
    dispose(): void {
        this.stopListening();
        this.clearHistory();
        this._targetCharacter = null;
        this._registeredActions.clear();
        this.removeAllListeners();
    }
    
    // ==================== Private Methods ====================
    
    /**
     * Handle bot response and parse action tags.
     */
    private handleBotResponse(response: BotResponse): void {
        // Only parse final responses if configured to do so
        if (this._onlyFinalResponses && !response.isFinal) {
            return;
        }
        
        const text = response.text;
        if (!text || text.length === 0) {
            return;
        }
        
        // Parse action tags from the text
        const actions = this.parseActions(text, response.messageId);
        
        if (actions.length > 0) {
            this.log(`Found ${actions.length} action(s) in response: ${actions.map(a => a.name).join(', ')}`);
            
            const triggeredActions: ParsedAction[] = [];
            
            for (const action of actions) {
                // Check if action should be triggered
                const shouldTrigger = this.shouldTriggerAction(action.name);
                
                if (!shouldTrigger) {
                    this.log(`Action '${action.name}' not registered, skipping (strict mode)`);
                    continue;
                }
                
                // Update current action
                this._currentAction = action;
                
                // Add to history
                this._actionHistory.push(action);
                triggeredActions.push(action);
                
                // Dispatch to all event systems
                this.dispatchAction(action);
            }
            
            // Trim history if needed
            if (this._actionHistory.length > this._maxHistorySize) {
                this._actionHistory = this._actionHistory.slice(-this._maxHistorySize);
            }
            
            // Emit batch event for triggered actions
            if (triggeredActions.length > 0) {
                this.emit('actionsParsed', triggeredActions);
            }
        }
    }
    
    /**
     * Check if an action should be triggered based on registration and strict mode.
     */
    private shouldTriggerAction(actionName: string): boolean {
        // In non-strict mode, always trigger
        if (!this._strictMode) {
            return true;
        }
        
        // In strict mode, check if action is registered
        // Get characterId from singleton when needed
        const characterId = EstuaryCredentials.hasInstance && EstuaryCredentials.instance
            ? EstuaryCredentials.instance.characterId || '*'
            : '*';
        return this.isActionRegistered(characterId, actionName);
    }
    
    /**
     * Dispatch an action to all registered handlers.
     */
    private dispatchAction(action: ParsedAction): void {
        const lowerName = action.name.toLowerCase();
        
        // Emit general action event (for onAnyAction subscribers)
        this.emit('actionTriggered', action);
        
        // Emit action-specific event (e.g., 'action:sit' for onAction subscribers)
        this.emit(`action:${lowerName}`, action);
        
        this.log(`Dispatched action '${action.name}'`);
    }
    
    /**
     * Parse action tags from text using regex.
     * @param text The text to parse
     * @param messageId The message ID this text came from
     * @returns Array of parsed actions
     */
    private parseActions(text: string, messageId: string): ParsedAction[] {
        const actions: ParsedAction[] = [];
        const regex = new RegExp(this._actionTagRegex);
        let match: RegExpExecArray | null;
        
        // Reset regex lastIndex to ensure we start from the beginning
        regex.lastIndex = 0;
        
        while ((match = regex.exec(text)) !== null) {
            const actionName = match[1].trim();
            const fullTag = match[0];
            
            if (actionName.length > 0) {
                const action: ParsedAction = {
                    name: actionName,
                    tag: fullTag,
                    messageId: messageId || '',
                    timestamp: Date.now()
                };
                
                actions.push(action);
            }
        }
        
        return actions;
    }
    
    // ==================== Logging ====================
    
    private log(message: string): void {
        if (this._debugLogging) {
            print(`[EstuaryActionManager] ${message}`);
        }
    }
    
    private logError(message: string): void {
        print(`[EstuaryActionManager] ERROR: ${message}`);
    }
}

/**
 * EstuaryActionManagerComponent - Lens Studio component wrapper for EstuaryActionManager.
 * 
 * This is an optional component for the Estuary SDK. You can either:
 * 1. Use SimpleAutoConnect (recommended) - it creates and manages the action manager automatically
 * 2. Add this component to a SceneObject for more control
 * 
 * The component creates an EstuaryActionManager instance that parses action tags from
 * bot responses and dispatches them to EstuaryActionReceiver components.
 * 
 * Setup in Lens Studio:
 * 1. Create a SceneObject (e.g., "Action Manager")
 * 2. Add this script to the SceneObject
 * 3. Call setTargetCharacter() from your main script after creating the character
 * 4. EstuaryActionReceiver components will auto-discover this manager
 */
@component
export class EstuaryActionManagerComponent extends BaseScriptComponent {
    
    // ==================== Configuration (set in Inspector) ====================
    
    /**
     * Reference to the EstuaryCredentials SceneObject.
     * If not set, will use the EstuaryCredentials singleton.
     */
    @input
    @hint("SceneObject with EstuaryCredentials (optional, uses singleton if not set)")
    credentialsObject: SceneObject;
    
    /**
     * Whether to only trigger registered actions.
     * If true, unregistered actions will be ignored.
     * If false (default), all actions will be triggered.
     */
    @input
    @hint("Only trigger registered actions (ignore unknown actions)")
    strictMode: boolean = false;
    
    /**
     * Enable debug logging.
     */
    @input
    @hint("Enable debug logging")
    debugMode: boolean = false;
    
    // ==================== State ====================
    
    /** The internal action manager instance */
    private _manager: EstuaryActionManager | null = null;
    
    // ==================== Singleton ====================
    
    private static _instance: EstuaryActionManagerComponent | null = null;
    
    /**
     * Get the singleton instance.
     */
    static get instance(): EstuaryActionManagerComponent | null {
        return EstuaryActionManagerComponent._instance;
    }
    
    /**
     * Check if an instance exists.
     */
    static get hasInstance(): boolean {
        return EstuaryActionManagerComponent._instance !== null;
    }
    
    // ==================== Properties ====================
    
    /**
     * Get the internal EstuaryActionManager instance.
     */
    get manager(): EstuaryActionManager | null {
        return this._manager;
    }
    
    /**
     * Get the current action.
     */
    get currentAction(): ParsedAction | null {
        return this._manager?.currentAction || null;
    }
    
    /**
     * Get the action history.
     */
    get actionHistory(): ReadonlyArray<ParsedAction> {
        return this._manager?.actionHistory || [];
    }
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        // Create the manager
        this._manager = new EstuaryActionManager();
        this._manager.debugLogging = this.debugMode;
        this._manager.strictMode = this.strictMode;
        
        // Get credentials
        if (this.credentialsObject) {
            this._manager.setCredentialsFromSceneObject(this.credentialsObject);
        } else {
            this._manager.setCredentialsFromSingleton();
        }
        
        // Register as singleton
        if (EstuaryActionManagerComponent._instance === null) {
            EstuaryActionManagerComponent._instance = this;
        }
        
        this.log("EstuaryActionManagerComponent initialized");
        this.log("Call setTargetCharacter() to connect to an EstuaryCharacter");
    }
    
    onDestroy() {
        if (this._manager) {
            this._manager.dispose();
            this._manager = null;
        }
        if (EstuaryActionManagerComponent._instance === this) {
            EstuaryActionManagerComponent._instance = null;
        }
    }
    
    // ==================== Public Methods ====================
    
    /**
     * Set the target character to monitor for bot responses.
     * Call this after creating your EstuaryCharacter.
     * 
     * @param character The EstuaryCharacter instance
     * 
     * @example
     * // In your main script after creating the character:
     * const character = new EstuaryCharacter(characterId, playerId);
     * 
     * // Get the action manager component and connect
     * const actionManagerComp = EstuaryActionManagerComponent.instance;
     * if (actionManagerComp) {
     *     actionManagerComp.setTargetCharacter(character);
     * }
     */
    setTargetCharacter(character: EstuaryCharacter): void {
        if (this._manager) {
            this._manager.setTargetCharacter(character);
            this.log(`Connected to character: ${character.characterId}`);
        }
    }
    
    /**
     * Register an action for the current character.
     * @param actionName The action name (e.g., "sit", "wave")
     * @param description Optional description
     */
    registerAction(actionName: string, description?: string): void {
        if (this._manager) {
            // Get characterId from singleton when needed
            const charId = EstuaryCredentials.hasInstance && EstuaryCredentials.instance
                ? EstuaryCredentials.instance.characterId || '*'
                : '*';
            this._manager.registerAction(charId, actionName, description);
        }
    }
    
    /**
     * Register multiple actions at once.
     * @param actionNames Array of action names
     */
    registerActions(actionNames: string[]): void {
        if (this._manager) {
            // Get characterId from singleton when needed
            const charId = EstuaryCredentials.hasInstance && EstuaryCredentials.instance
                ? EstuaryCredentials.instance.characterId || '*'
                : '*';
            this._manager.registerActions(charId, actionNames);
        }
    }
    
    /**
     * Subscribe to a specific action.
     * @param actionName The action name to listen for
     * @param handler Callback when action is received
     * @returns Unsubscribe function
     */
    onAction(actionName: string, handler: (action: ParsedAction) => void): () => void {
        return this._manager?.onAction(actionName, handler) || (() => {});
    }
    
    /**
     * Subscribe to all actions.
     * @param handler Callback when any action is received
     * @returns Unsubscribe function
     */
    onAnyAction(handler: (action: ParsedAction) => void): () => void {
        return this._manager?.onAnyAction(handler) || (() => {});
    }
    
    // ==================== Logging ====================
    
    private log(message: string): void {
        if (this.debugMode) {
            print(`[EstuaryActionManagerComponent] ${message}`);
        }
    }
}

// ============================================================================
// GLOBAL ACTION EVENTS - Easy access from any script
// ============================================================================

/**
 * Global action event system for the Estuary SDK.
 * 
 * This provides a simple, Unity-like event system where any script can
 * subscribe to action events without needing component references.
 * 
 * Usage from any script:
 * ```typescript
 * import { EstuaryActions } from 'estuary-lens-studio-sdk';
 * 
 * // Subscribe to a specific action
 * EstuaryActions.on("sit", (action) => {
 *     print("Character should sit!");
 *     // Play sit animation, change state, etc.
 * });
 * 
 * // Subscribe to all actions
 * EstuaryActions.onAny((action) => {
 *     print(`Action triggered: ${action.name}`);
 * });
 * 
 * // Unsubscribe when done
 * const unsubscribe = EstuaryActions.on("wave", handler);
 * unsubscribe(); // Stop listening
 * ```
 */
export class EstuaryActions {
    private static _manager: EstuaryActionManager | null = null;
    private static _pendingSubscriptions: Array<{
        type: 'specific' | 'any';
        actionName?: string;
        handler: (action: ParsedAction) => void;
        unsubscribe?: () => void;
    }> = [];
    
    /**
     * Set the action manager instance (called internally by SimpleAutoConnect).
     * @internal
     */
    static setManager(manager: EstuaryActionManager): void {
        EstuaryActions._manager = manager;
        
        // Process any pending subscriptions
        for (const sub of EstuaryActions._pendingSubscriptions) {
            if (sub.type === 'any') {
                sub.unsubscribe = manager.onAnyAction(sub.handler);
            } else if (sub.actionName) {
                sub.unsubscribe = manager.onAction(sub.actionName, sub.handler);
            }
        }
    }
    
    /**
     * Get the current action manager instance.
     */
    static getManager(): EstuaryActionManager | null {
        return EstuaryActions._manager;
    }
    
    /**
     * Subscribe to a specific action by name.
     * 
     * @param actionName The action name to listen for (e.g., "sit", "wave")
     * @param handler Callback when the action is triggered
     * @returns Unsubscribe function
     * 
     * @example
     * ```typescript
     * EstuaryActions.on("sit", (action) => {
     *     print("Character is sitting!");
     * });
     * ```
     */
    static on(actionName: string, handler: (action: ParsedAction) => void): () => void {
        if (EstuaryActions._manager) {
            return EstuaryActions._manager.onAction(actionName, handler);
        }
        
        // Queue for when manager is set
        const sub = {
            type: 'specific' as const,
            actionName,
            handler,
            unsubscribe: undefined as (() => void) | undefined
        };
        EstuaryActions._pendingSubscriptions.push(sub);
        
        return () => {
            if (sub.unsubscribe) {
                sub.unsubscribe();
            }
            const index = EstuaryActions._pendingSubscriptions.indexOf(sub);
            if (index > -1) {
                EstuaryActions._pendingSubscriptions.splice(index, 1);
            }
        };
    }
    
    /**
     * Subscribe to ALL actions.
     * 
     * @param handler Callback when any action is triggered
     * @returns Unsubscribe function
     * 
     * @example
     * ```typescript
     * EstuaryActions.onAny((action) => {
     *     print(`Action: ${action.name}`);
     * });
     * ```
     */
    static onAny(handler: (action: ParsedAction) => void): () => void {
        if (EstuaryActions._manager) {
            return EstuaryActions._manager.onAnyAction(handler);
        }
        
        // Queue for when manager is set
        const sub = {
            type: 'any' as const,
            handler,
            unsubscribe: undefined as (() => void) | undefined
        };
        EstuaryActions._pendingSubscriptions.push(sub);
        
        return () => {
            if (sub.unsubscribe) {
                sub.unsubscribe();
            }
            const index = EstuaryActions._pendingSubscriptions.indexOf(sub);
            if (index > -1) {
                EstuaryActions._pendingSubscriptions.splice(index, 1);
            }
        };
    }
    
    /**
     * Check if an action was recently triggered.
     * @param actionName The action name to check
     */
    static wasTriggered(actionName: string): boolean {
        if (!EstuaryActions._manager) return false;
        return EstuaryActions._manager.currentAction?.name === actionName;
    }
    
    /**
     * Get the most recently triggered action.
     */
    static get currentAction(): ParsedAction | null {
        return EstuaryActions._manager?.currentAction || null;
    }
    
    /**
     * Get all actions triggered in the current session.
     */
    static get actionHistory(): ReadonlyArray<ParsedAction> {
        return EstuaryActions._manager?.actionHistory || [];
    }
}
