import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { ApiEndpointResult, DelegationUpdate } from '../src/Models/ConversationEvents';

/** Optional result card. Pass existing Text/Image components from an SIK panel. */
export function bindConversationResults(
    character: EstuaryCharacter,
    statusText: Text,
    resultImage: Image,
    internet: InternetModule,
    media: RemoteMediaModule,
): () => void {
    let generation = 0;
    let messageId = '';
    const originalTexture = resultImage.mainPass.baseTex;
    const status = (data: DelegationUpdate) => {
        statusText.text = `Task: ${data.status}`;
        // This example only displays progress; it performs no authorization.
    };
    const clear = () => { generation++; resultImage.mainPass.baseTex = originalTexture; };
    const result = (data: ApiEndpointResult) => {
        clear();
        messageId = data.message_id;
        const current = generation;
        const image = data.media.find(item => item && item.type === 'image' && httpsMediaUrl(item.url));
        const citations = Array.isArray(data.citations) ? data.citations : [];
        statusText.text = [image?.title || data.operation, ...citations.slice(0, 3).map(item => item?.title || '')]
            .filter(Boolean).join('\n').slice(0, 512);
        if (!image) return;
        // Deliberately uses the remote media API, with no Estuary API-key headers.
        try {
            const resource = internet.makeResourceFromUrl(image.url);
            media.loadResourceAsImageTexture(resource, texture => {
                if (generation === current) resultImage.mainPass.baseTex = texture;
            }, () => { if (generation === current) statusText.text += '\nImage unavailable'; });
        } catch (_) { statusText.text += '\nImage unavailable'; }
    };
    const redacted = (data: { message_id: string }) => {
        if (data.message_id === messageId) { clear(); statusText.text = 'Response removed'; }
    };
    character.on('delegationUpdate', status);
    character.on('apiEndpointResult', result);
    character.on('responseRedacted', redacted);
    character.on('disconnected', clear);
    const dispose = () => {
        clear();
        character.off('delegationUpdate', status);
        character.off('apiEndpointResult', result);
        character.off('responseRedacted', redacted);
        character.off('disconnected', clear);
        character.off('disposed', dispose);
    };
    character.on('disposed', dispose);
    return dispose;
}

/** The gateway checks public hosts too. Recheck scheme and reject embedded credentials locally. */
function httpsMediaUrl(value: unknown): value is string {
    return typeof value === 'string' && /^https:\/\/[^\s/@\\?#]+(?:[/?#]|$)/i.test(value);
}
