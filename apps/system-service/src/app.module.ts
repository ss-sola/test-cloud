import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { WORKFLOW_DIRECTORY_ROOT } from './constants/workflow-directory.constants';

@Module({
  imports: [
    ServeStaticModule.forRoot(
      {
        rootPath: WORKFLOW_DIRECTORY_ROOT,
        serveRoot: '/public/workflow',
        serveStaticOptions: { index: false, dotfiles: 'deny', fallthrough: false },
      },
      {
        rootPath: join(__dirname, 'public'),
        serveRoot: '/public',
      },
    ),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
