import { trainLstmModel } from './lstm_prediction.js';

self.addEventListener('message', async event => {
    const { catalogId, observations } = event.data;
    try {
        const metadata = await trainLstmModel(catalogId, observations, (epoch, totalEpochs) => {
            self.postMessage({ type: 'progress', epoch, totalEpochs });
        });
        self.postMessage({ type: 'complete', metadata });
    } catch (error) {
        self.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
