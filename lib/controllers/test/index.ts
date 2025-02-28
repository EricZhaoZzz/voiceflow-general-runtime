import { Validator } from '@voiceflow/backend-utils';
import { BaseModels, BaseUtils } from '@voiceflow/base-types';
import VError from '@voiceflow/verror';
import _merge from 'lodash/merge';

import { FeatureFlag } from '@/lib/feature-flags';
import { getAPIBlockHandlerOptions } from '@/lib/services/runtime/handlers/api';
import { fetchFaq, fetchKnowledgeBase } from '@/lib/services/runtime/handlers/utils/knowledgeBase';
import { SegmentEventType } from '@/lib/services/runtime/types';
import log from '@/logger';
import { callAPI } from '@/runtime/lib/Handlers/api/utils';
import { ivmExecute } from '@/runtime/lib/Handlers/code/utils';
import { Request, Response } from '@/types';

import { QuotaName } from '../../services/billing';
import { fetchPrompt } from '../../services/runtime/handlers/utils/ai';
import { validate } from '../../utils';
import { AbstractController } from '../utils';
import { TestFunctionBody, TestFunctionParams, TestFunctionResponse, TestFunctionStatus } from './interface';

const { body } = Validator;

const VALIDATIONS = {
  BODY: {
    CHUNK_LIMIT: body('chunkLimit').optional().isInt({ min: 1, max: 10 }),
    QUESTION: body('question').exists().isString(),
    SYNTHESIS: body('synthesis').optional().isBoolean(),
  },
};

class TestController extends AbstractController {
  async testAPI(req: Request, res: Response) {
    const { responseJSON } = await callAPI(req.body.api, getAPIBlockHandlerOptions(this.config));
    if (responseJSON.VF_STATUS_CODE) {
      res.status(responseJSON.VF_STATUS_CODE);
    }
    res.send(responseJSON);
  }

  async testCode(req: Request, res: Response) {
    if (typeof req.body.code !== 'string') {
      res.status(400).send({ error: 'code must be a string' });
      return;
    }
    if (typeof req.body.variables !== 'object') {
      res.status(400).send({ error: 'variables must be an object' });
      return;
    }

    try {
      const startTime = performance.now();
      const variables = await ivmExecute({ code: req.body.code, variables: req.body.variables });
      res.send({ variables, time: performance.now() - startTime });
    } catch (error) {
      res.status(400).send({ error: error.message });
    }
  }

  static generateTagLabelMap(existingTags: Record<string, BaseModels.Project.KBTag>): Record<string, string> {
    const result: Record<string, string> = {};

    Object.entries(existingTags).forEach(([tagID, tag]) => {
      result[tag.label] = tagID;
    });

    return result;
  }

  static checkKBTagLabelsExists(tagLabelMap: Record<string, string>, tagLabels: string[]) {
    // check that KB tag labels exists, this is not atomic but it prevents a class of bugs
    const nonExistingTags = tagLabels.filter((label) => !tagLabelMap[label]);

    if (nonExistingTags.length > 0) {
      const formattedTags = nonExistingTags.map((tag) => `\`${tag}\``).join(', ');
      throw new VError(`tags with the following labels do not exist: ${formattedTags}`, VError.HTTP_STATUS.NOT_FOUND);
    }
  }

  static convertTagsFilterToIDs(
    tags: BaseModels.Project.KnowledgeBaseTagsFilter,
    tagLabelMap: Record<string, string>
  ): BaseModels.Project.KnowledgeBaseTagsFilter {
    const result = tags;
    const includeTagsArray = result?.include?.items ?? [];
    const excludeTagsArray = result?.exclude?.items ?? [];

    if (includeTagsArray.length > 0 || excludeTagsArray.length > 0) {
      TestController.checkKBTagLabelsExists(
        tagLabelMap,
        Array.from(new Set([...includeTagsArray, ...excludeTagsArray]))
      );
    }

    if (result?.include?.items) {
      result.include.items = result.include.items
        .filter((label) => tagLabelMap[label] !== undefined)
        .map((label) => tagLabelMap[label]);
    }

    if (result?.exclude?.items) {
      result.exclude.items = result.exclude.items
        .filter((label) => tagLabelMap[label] !== undefined)
        .map((label) => tagLabelMap[label]);
    }

    return result;
  }

  testSendSegmentTagsFilterEvent = async ({
    userID,
    tagsFilter,
  }: {
    userID: number;
    tagsFilter: BaseModels.Project.KnowledgeBaseTagsFilter;
  }) => {
    const analyticsPlatformClient = await this.services.analyticsPlatform.getClient();
    const operators: string[] = [];

    if (tagsFilter?.includeAllTagged) operators.push('includeAllTagged');
    if (tagsFilter?.includeAllNonTagged) operators.push('includeAllNonTagged');
    if (tagsFilter?.include) operators.push('include');
    if (tagsFilter?.exclude) operators.push('exclude');

    const includeTagsArray = tagsFilter?.include?.items || [];
    const excludeTagsArray = tagsFilter?.exclude?.items || [];
    const tags = Array.from(new Set([...includeTagsArray, ...excludeTagsArray]));

    if (analyticsPlatformClient) {
      analyticsPlatformClient.track({
        identity: { userID },
        name: SegmentEventType.KB_TAGS_USED,
        properties: { operators, tags_searched: tags, number_of_tags: tags.length },
      });
    }
  };

  async testKnowledgeBasePrompt(req: Request) {
    const api = await this.services.dataAPI.get();

    // if DM API key infer project from header
    const project = await api.getProject(req.body.projectID || req.headers.authorization);
    const settings = _merge({}, project.knowledgeBase?.settings, req.body.settings);

    const { prompt } = req.body;

    const answer = await this.services.aiSynthesis.promptSynthesis(
      project._id,
      project.teamID,
      { ...settings.summarization, prompt },
      {}
    );

    if (!answer?.output) return { output: null };

    if (typeof answer.tokens === 'number' && answer.tokens > 0) {
      await this.services.billing
        .consumeQuota(req.params.workspaceID, QuotaName.OPEN_API_TOKENS, answer.tokens)
        .catch((err: Error) =>
          log.warn(
            `[KB Prompt Test] Error consuming quota for workspace ${req.params.workspaceID}: ${log.vars({ err })}`
          )
        );
    }

    return { output: answer.output };
  }

  @validate({
    BODY_CHUNK_LIMIT: VALIDATIONS.BODY.CHUNK_LIMIT,
    BODY_QUESTION: VALIDATIONS.BODY.QUESTION,
    BODY_SYNTHESIS: VALIDATIONS.BODY.SYNTHESIS,
  })
  async testKnowledgeBase(
    req: Request<
      any,
      {
        projectID?: string;
        question: string;
        synthesis?: boolean;
        chunkLimit?: number;
        tags?: BaseModels.Project.KnowledgeBaseTagsFilter;
      }
    >
  ) {
    const { question, synthesis = true, chunkLimit, tags } = req.body;
    let tagsFilter: BaseModels.Project.KnowledgeBaseTagsFilter = {};

    const api = await this.services.dataAPI.get();
    // if DM API key infer project from header
    const project = await api.getProject(req.body.projectID || req.headers.authorization!);
    if (tags) {
      const tagLabelMap = TestController.generateTagLabelMap(project.knowledgeBase?.tags ?? {});
      tagsFilter = TestController.convertTagsFilterToIDs(tags, tagLabelMap);

      this.testSendSegmentTagsFilterEvent({ userID: project.creatorID, tagsFilter });
    }

    if (!(await this.services.billing.checkQuota(project.teamID, QuotaName.OPEN_API_TOKENS))) {
      throw new VError('token quota exceeded', VError.HTTP_STATUS.PAYMENT_REQUIRED);
    }

    const settings = _merge({}, project.knowledgeBase?.settings, { search: { limit: chunkLimit } });

    if (this.services.unleash.client.isEnabled(FeatureFlag.FAQ_FF, { workspaceID: Number(project.teamID) })) {
      const faq = await fetchFaq(project._id, project.teamID, question, project?.knowledgeBase?.faqSets, settings);
      if (faq?.answer) return { output: faq.answer, faqSet: faq.faqSet };
    }

    const data = await fetchKnowledgeBase(project._id, project.teamID, question, settings, tagsFilter);
    if (!data) return { output: null, chunks: [] };

    // attach metadata to chunks
    const chunks = data.chunks.map((chunk) => ({
      ...chunk,
      source: {
        ...project.knowledgeBase?.documents?.[chunk.documentID]?.data,
        tags: project.knowledgeBase?.documents?.[chunk.documentID]?.tags?.map(
          (tagID) => (project?.knowledgeBase?.tags ?? {})[tagID]?.label
        ),
      },
    }));

    if (!synthesis) return { output: null, chunks };

    const answer = await this.services.aiSynthesis.answerSynthesis({
      question,
      data,
      options: settings?.summarization,
      context: { projectID: project._id, workspaceID: project.teamID },
    });

    if (!answer?.output) return { output: null, chunks };

    // do this async to not block the response
    if (typeof answer.tokens === 'number' && answer.tokens > 0) {
      this.services.billing
        .consumeQuota(project.teamID, QuotaName.OPEN_API_TOKENS, answer.tokens)
        .catch((err: Error) =>
          log.warn(`[KB Test] Error consuming quota for workspace ${project.teamID}: ${log.vars({ err })}`)
        );
    }

    return {
      output: answer.output,
      chunks,
      queryTokens: answer.queryTokens,
      answerTokens: answer.answerTokens,
      totalTokens: answer.tokens,
    };
  }

  async testCompletion(
    req: Request<BaseUtils.ai.AIModelParams & BaseUtils.ai.AIContextParams & { workspaceID: string }>
  ) {
    const model = this.services.ai.get(req.body.model);

    if (!model) throw new VError('invalid model', VError.HTTP_STATUS.BAD_REQUEST);
    if (typeof req.body.prompt !== 'string') throw new VError('invalid prompt', VError.HTTP_STATUS.BAD_REQUEST);

    const { output, tokens } = await fetchPrompt(
      req.body,
      model,
      { context: { workspaceID: req.params.workspaceID } },
      {}
    );

    if (typeof tokens === 'number' && tokens > 0) {
      await this.services.billing
        .consumeQuota(req.params.workspaceID, QuotaName.OPEN_API_TOKENS, tokens)
        .catch((err: Error) =>
          log.warn(
            `[Completion Test] Error consuming quota for workspace ${req.params.workspaceID}: ${log.vars({ err })}`
          )
        );
    }

    return { output };
  }

  async testFunction(req: Request<TestFunctionParams, TestFunctionBody>): Promise<TestFunctionResponse> {
    const {
      params: { functionID },
      body: inputMapping,
    } = req;

    await this.services.test.testFunction(functionID, inputMapping);

    return {
      status: TestFunctionStatus.Success,
      latencyMS: 483,
      outputMapping: {
        str_value: 'hello, world!',
        num_value: 123456.789,
        bool_value: true,
        arr_value: ['a', 'b', 'c', ['1', '2', '3'], { a: '1', b: 2, c: false }],
        obj_value: {
          x: 1,
          y: 'string',
          z: true,
          w: [1, '2', false, [1, 2, 3], { a: 1 }],
          v: {
            '1': 1,
            2: 2,
            '3': false,
          },
        },
      },
    };
  }
}

export default TestController;
