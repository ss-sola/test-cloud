import { bootstrap } from '@nest-cloud/common';
import { AppModule } from './app.module';
import { BullmqDashboardService } from './modules/bullmq-dashboard/bullmq-dashboard.service';
import { SystemServiceConfig } from './validate.config';

void bootstrap({
  AppModule,
  validateConfig: SystemServiceConfig,
  configureApp: async (app) => {
    await app.get(BullmqDashboardService).mount(app);
  },
});
