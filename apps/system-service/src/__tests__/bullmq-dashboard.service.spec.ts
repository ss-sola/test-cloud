import { describe, expect, it, vi } from 'vitest';
import { BullmqDashboardService } from '../modules/bullmq-dashboard/bullmq-dashboard.service';

function responseMock() {
  const response = {
    status: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.type.mockReturnValue(response);
  response.send.mockReturnValue(response);
  return response;
}

describe('BullmqDashboardService', () => {
  it('mounts the panel at the configured operations path', async () => {
    const app = { use: vi.fn() };
    const service = new BullmqDashboardService();

    await service.mount(app);

    expect(app.use).toHaveBeenCalledWith('/ops/queues', expect.any(Function), expect.any(Function));
    await service.onModuleDestroy();
  });

  it('rejects writes and hides Redis stats at the adapter boundary', async () => {
    const app = { use: vi.fn() };
    const service = new BullmqDashboardService();
    await service.mount(app);
    const middleware = app.use.mock.calls[0][1] as (
      request: { method: string; path: string },
      response: ReturnType<typeof responseMock>,
      next: () => void,
    ) => void;
    const next = vi.fn();

    const writeResponse = responseMock();
    middleware({ method: 'POST', path: '/' }, writeResponse, next);
    expect(writeResponse.status).toHaveBeenCalledWith(405);
    expect(next).not.toHaveBeenCalled();

    const statsResponse = responseMock();
    middleware({ method: 'GET', path: '/api/redis/stats' }, statsResponse, next);
    expect(statsResponse.status).toHaveBeenCalledWith(404);

    const readResponse = responseMock();
    middleware({ method: 'GET', path: '/' }, readResponse, next);
    expect(next).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });
});
