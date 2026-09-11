import { Injectable } from '@nestjs/common';
import { ProjectException } from '@nest-cloud/common';
import { ConfigFilePreviewDto } from './dto/config-file-preview.dto';
import { ConfigFilePreviewTagsDto } from './dto/config-file-preview-tags.dto';

@Injectable()
export class ConfigFilePreviewService {
  async getTags(body: ConfigFilePreviewTagsDto, signal?: AbortSignal) {
    const repository = body.repositoryUrl
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/$/, '');
    const token = body.githubToken.trim();
    const response = await fetch('https://api.github.com/repos/' + repository + '/tags', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      signal,
    });

    if (!response.ok) {
      throw new ProjectException(
        `GitHub API error: ${response.status} ${await response.text()}`,
        response.status,
      );
    }

    return response.json();
  }

  async preview(body: ConfigFilePreviewDto, signal?: AbortSignal) {
    const repository = body.repositoryUrl
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/$/, '');
    const filePath = body.filePath.trim();
    const branch = body.branch.trim();
    let tag = body.tag?.trim() ?? '';
    const token = body.githubToken.trim();

    if (!tag) {
      const tags = await this.getTags(
        { repositoryUrl: body.repositoryUrl, githubToken: body.githubToken },
        signal,
      );
      if (!Array.isArray(tags)) {
        throw new ProjectException('GitHub tags 响应格式无效', 502);
      }
      tag =
        tags.find((item) => typeof item?.name === 'string' && item.name.trim())?.name.trim() ?? '';
      if (!tag) {
        throw new ProjectException('GitHub 仓库没有可用 tag', 404);
      }
    }

    const url =
      'https://api.github.com/repos/' + repository + '/contents/' + filePath + '?ref=' + tag;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      signal,
    });

    if (!response.ok) {
      throw new ProjectException(
        `GitHub API error: ${response.status} ${await response.text()}`,
        response.status,
      );
    }

    const data = (await response.json()) as { content: string };
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return {
      repositoryUrl: body.repositoryUrl.trim(),
      branch,
      filePath,
      selectedTag: tag,
      tags: [{ name: tag }],
      content,
      byteLength: Buffer.byteLength(content, 'utf-8'),
    };
  }
}
