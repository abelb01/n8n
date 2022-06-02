/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable no-param-reassign */
/* eslint-disable import/no-cycle */

import express from 'express';
import { INode, LoggerProxy } from 'n8n-workflow';

import { Db, ResponseHelper, whereClause, WorkflowHelpers } from '..';
import config from '../../config';
import * as TagHelpers from '../TagHelpers';
import { SharedWorkflow } from '../databases/entities/SharedWorkflow';
import { WorkflowEntity } from '../databases/entities/WorkflowEntity';
import { validateEntity } from '../GenericHelpers';
import { InternalHooksManager } from '../InternalHooksManager';
import { externalHooks } from '../Server';
import type { WorkflowRequest } from '../requests';

export const workflowsController = express.Router();

/**
 * POST /workflows
 */
workflowsController.post(
	'/',
	ResponseHelper.send(async (req: WorkflowRequest.Create) => {
		delete req.body.id; // delete if sent

		const newWorkflow = new WorkflowEntity();

		const { nodes = [], ...restOfWorkflow } = req.body;

		const { workflowNodes, workflowPinData } = nodes.reduce<{
			workflowNodes: INode[];
			workflowPinData: { [nodeName: string]: object };
		}>(
			(acc, node) => {
				const { pinData: nodePinData, ...restOfNode } = node;
				if (nodePinData) acc.workflowPinData[node.name] = nodePinData;
				acc.workflowNodes.push(restOfNode);

				return acc;
			},
			{ workflowNodes: [], workflowPinData: {} },
		);

		Object.assign(
			newWorkflow,
			{ nodes: workflowNodes },
			{ pinData: Object.keys(workflowPinData).length > 0 ? JSON.stringify(workflowPinData) : null },
			restOfWorkflow,
		);

		await validateEntity(newWorkflow);

		await externalHooks.run('workflow.create', [newWorkflow]);

		const { tags: tagIds } = req.body;

		if (tagIds?.length && !config.getEnv('workflowTagsDisabled')) {
			newWorkflow.tags = await Db.collections.Tag.findByIds(tagIds, {
				select: ['id', 'name'],
			});
		}

		await WorkflowHelpers.replaceInvalidCredentials(newWorkflow);

		let savedWorkflow: undefined | WorkflowEntity;

		await Db.transaction(async (transactionManager) => {
			savedWorkflow = await transactionManager.save<WorkflowEntity>(newWorkflow);

			const role = await Db.collections.Role.findOneOrFail({
				name: 'owner',
				scope: 'workflow',
			});

			const newSharedWorkflow = new SharedWorkflow();

			Object.assign(newSharedWorkflow, {
				role,
				user: req.user,
				workflow: savedWorkflow,
			});

			await transactionManager.save<SharedWorkflow>(newSharedWorkflow);
		});

		if (!savedWorkflow) {
			LoggerProxy.error('Failed to create workflow', { userId: req.user.id });
			throw new ResponseHelper.ResponseError('Failed to save workflow');
		}

		if (tagIds && !config.getEnv('workflowTagsDisabled')) {
			savedWorkflow.tags = TagHelpers.sortByRequestOrder(savedWorkflow.tags, {
				requestOrder: tagIds,
			});
		}

		await externalHooks.run('workflow.afterCreate', [savedWorkflow]);
		void InternalHooksManager.getInstance().onWorkflowCreated(req.user.id, newWorkflow);

		const { id, ...rest } = savedWorkflow;

		return {
			id: id.toString(),
			...rest,
		};
	}),
);

/**
 * GET /workflows/:id
 */
workflowsController.get(
	'/:id',
	ResponseHelper.send(async (req: WorkflowRequest.Get) => {
		const { id: workflowId } = req.params;

		let relations = ['workflow', 'workflow.tags'];

		if (config.getEnv('workflowTagsDisabled')) {
			relations = relations.filter((relation) => relation !== 'workflow.tags');
		}

		const shared = await Db.collections.SharedWorkflow.findOne({
			relations,
			where: whereClause({
				user: req.user,
				entityType: 'workflow',
				entityId: workflowId,
			}),
		});

		if (!shared) {
			LoggerProxy.info('User attempted to access a workflow without permissions', {
				workflowId,
				userId: req.user.id,
			});
			throw new ResponseHelper.ResponseError(
				`Workflow with ID "${workflowId}" could not be found.`,
				undefined,
				404,
			);
		}

		const {
			workflow: { id, name, nodes, pinData, ...rest },
		} = shared;

		const pinDataObject: { [nodeName: string]: object } | null =
			typeof pinData === 'string' ? JSON.parse(pinData) : pinData;

		const workflowNodes = nodes.map((node) => {
			if (!pinDataObject) return node;

			if (pinDataObject[node.name]) {
				node.pinData = pinDataObject[node.name];
			}

			return node;
		});

		return {
			id: id.toString(),
			name,
			nodes: workflowNodes,
			...rest,
		};
	}),
);