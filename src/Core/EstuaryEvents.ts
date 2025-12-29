/**
 * Event types and connection states for Estuary SDK.
 */

import { SessionInfo } from '../Models/SessionInfo';
import { BotResponse } from '../Models/BotResponse';
import { BotVoice } from '../Models/BotVoice';
import { SttResponse } from '../Models/SttResponse';
import { InterruptData } from '../Models/InterruptData';

/**
 * Connection states for the Estuary client.
 */
export enum ConnectionState {
    /** Not connected to the server */
    Disconnected = 'disconnected',

    /** Currently attempting to connect */
    Connecting = 'connecting',

    /** Connected and ready to communicate */
    Connected = 'connected',

    /** Connection was lost, attempting to reconnect */
    Reconnecting = 'reconnecting',

    /** An error occurred during connection */
    Error = 'error'
}

/**
 * Event handler types for Estuary events.
 */
export type SessionConnectedHandler = (sessionInfo: SessionInfo) => void;
export type DisconnectedHandler = (reason: string) => void;
export type BotResponseHandler = (response: BotResponse) => void;
export type BotVoiceHandler = (voice: BotVoice) => void;
export type SttResponseHandler = (response: SttResponse) => void;
export type InterruptHandler = (data: InterruptData) => void;
export type ErrorHandler = (errorMessage: string) => void;
export type ConnectionStateHandler = (state: ConnectionState) => void;

/**
 * Simple event emitter for Estuary SDK.
 * Provides type-safe event subscription and emission.
 */
export class EventEmitter<T extends { [key: string]: (...args: any[]) => void }> {
    private listeners: Map<string, Set<Function>> = new Map();

    /**
     * Subscribe to an event.
     * @param event Event name
     * @param handler Event handler function
     */
    on(event: string, handler: Function): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(handler);
    }

    /**
     * Unsubscribe from an event.
     * @param event Event name
     * @param handler Event handler function to remove
     */
    off(event: string, handler: Function): void {
        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.delete(handler);
        }
    }

    /**
     * Emit an event to all subscribers.
     * @param event Event name
     * @param args Arguments to pass to handlers
     */
    emit(event: string, ...args: any[]): void {
        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(...args);
                } catch (e) {
                    print(`[EventEmitter] Error in handler for ${event}: ${e}`);
                }
            });
        }
    }

    /**
     * Remove all listeners for an event, or all events if no event specified.
     * @param event Optional event name
     */
    removeAllListeners(event?: string): void {
        if (event) {
            this.listeners.delete(event);
        } else {
            this.listeners.clear();
        }
    }

    /**
     * Get the number of listeners for an event.
     * @param event Event name
     */
    listenerCount(event: string): number {
        return this.listeners.get(event)?.size ?? 0;
    }
}

/**
 * Estuary client event map for type-safe event handling.
 */
export interface EstuaryClientEvents {
    sessionConnected: SessionConnectedHandler;
    disconnected: DisconnectedHandler;
    botResponse: BotResponseHandler;
    botVoice: BotVoiceHandler;
    sttResponse: SttResponseHandler;
    interrupt: InterruptHandler;
    error: ErrorHandler;
    connectionStateChanged: ConnectionStateHandler;
}





