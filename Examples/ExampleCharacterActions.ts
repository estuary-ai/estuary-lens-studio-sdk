/**
 * MyCharacterActions.ts
 * 
 * EXAMPLE: How to use EstuaryActions in your own scripts.
 * 
 * This demonstrates the SDK's event-driven action system.
 * Just drag this script onto any SceneObject - no configuration needed!
 * 
 * When the AI character triggers an action (e.g., "sit", "wave"), 
 * this script will be notified and can respond accordingly.
 */

import { EstuaryActions, ParsedAction } from '../src/Components/EstuaryActionManager';

@component
export class MyCharacterActions extends BaseScriptComponent {
    
    // Store unsubscribe functions for cleanup
    private _unsubscribes: (() => void)[] = [];
    
    onAwake() {
        print("[MyCharacterActions] Setting up action listeners...");
        
        // ============================================================
        // OPTION 1: Subscribe to SPECIFIC actions
        // ============================================================
        
        // Listen for "sit" action
        const unsubSit = EstuaryActions.on("sit", (action) => {
            this.onSit(action);
        });
        this._unsubscribes.push(unsubSit);
        
        // Listen for "wave" action
        const unsubWave = EstuaryActions.on("wave", (action) => {
            this.onWave(action);
        });
        this._unsubscribes.push(unsubWave);
        
        // Listen for "dance" action
        const unsubDance = EstuaryActions.on("dance", (action) => {
            this.onDance(action);
        });
        this._unsubscribes.push(unsubDance);
        
        // ============================================================
        // OPTION 2: Subscribe to ALL actions (alternative approach)
        // ============================================================
        
        // Uncomment this to receive ALL actions:
        // const unsubAll = EstuaryActions.onAny((action) => {
        //     this.onAnyAction(action);
        // });
        // this._unsubscribes.push(unsubAll);
        
        print("[MyCharacterActions] Ready! Listening for: sit, wave, dance");
    }
    
    onDestroy() {
        // Clean up subscriptions
        for (const unsub of this._unsubscribes) {
            unsub();
        }
        print("[MyCharacterActions] Cleaned up subscriptions");
    }
    
    // ============================================================
    // ACTION HANDLERS - Add your logic here!
    // ============================================================
    
    private onSit(action: ParsedAction): void {
        print("==============================================");
        print("[MyCharacterActions] SIT action received!");
        print("==============================================");
        
        // TODO: Add your sit logic here
        // Examples:
        // - Play sit animation
        // - Move character to sitting position
        // - Change character state
    }
    
    private onWave(action: ParsedAction): void {
        print("==============================================");
        print("[MyCharacterActions] WAVE action received!");
        print("==============================================");
        
        // TODO: Add your wave logic here
    }
    
    private onDance(action: ParsedAction): void {
        print("==============================================");
        print("[MyCharacterActions] DANCE action received!");
        print("==============================================");
        
        // TODO: Add your dance logic here
    }
    
    // Handler for ALL actions (if using Option 2)
    private onAnyAction(action: ParsedAction): void {
        print(`[MyCharacterActions] Action: ${action.name}`);
        
        // Handle dynamically based on action name
        switch (action.name.toLowerCase()) {
            case "sit":
                this.onSit(action);
                break;
            case "wave":
                this.onWave(action);
                break;
            case "dance":
                this.onDance(action);
                break;
            default:
                print(`[MyCharacterActions] Unknown action: ${action.name}`);
                break;
        }
    }
}
