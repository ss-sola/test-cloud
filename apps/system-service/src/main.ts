import { bootstrap } from '@nest-cloud/common';
import { AppModule } from './app.module';
import { BullmqDashboardService } from './modules/bullmq-dashboard/bullmq-dashboard.service';
import { ContentCompareHttpService } from './modules/content-compare/content-compare-http.service';
import { WorkflowCapabilityHttpService } from './modules/workflow-capabilities/workflow-capability-http.service';
import { WorkflowDirectoryHttpService } from './modules/workflow-directory/workflow-directory-http.service';
import { SystemServiceConfig } from './validate.config';

void bootstrap({
  AppModule,
  validateConfig: SystemServiceConfig,
  configureApp: async (app) => {
    await app.get(BullmqDashboardService).mount(app);
    app.get(ContentCompareHttpService).mount(app);
    app.get(WorkflowCapabilityHttpService).mount(app);
    app.get(WorkflowDirectoryHttpService).mount(app);
  },
});
