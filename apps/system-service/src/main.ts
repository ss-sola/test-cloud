import { bootstrap } from '@nest-cloud/common';
import { AppModule } from './app.module';
import { BullmqDashboardService } from './modules/bullmq-dashboard/bullmq-dashboard.service';

void bootstrap({
  AppModule,
  configureApp: async (app) => {
    await app.get(BullmqDashboardService).mount(app);
  },
});
