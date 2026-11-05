import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRobotAccounts } from './load-robot-accounts.ts';

test('loads every account while respecting the backend page size limit', async () => {
	const source = Array.from({ length: 107 }, (_, id) => ({ id: id + 1 }));
	const pages = [];
	const accounts = await loadRobotAccounts(async query => {
		assert.ok(query.page_size > 0 && query.page_size <= 50, 'backend rejects pages larger than 50');
		pages.push(query.page_index);
		const offset = (query.page_index - 1) * query.page_size;
		return { items: source.slice(offset, offset + query.page_size), total: source.length };
	});
	assert.deepEqual(accounts, source);
	assert.deepEqual(pages, [1, 2, 3]);
});

test('stops on an empty page when accounts disappear between page requests', async () => {
	let calls = 0;
	const accounts = await loadRobotAccounts(async () => {
		calls += 1;
		return { items: calls === 1 ? Array.from({ length: 50 }, (_, id) => ({ id })) : [], total: 100 };
	});
	assert.equal(accounts.length, 50);
	assert.equal(calls, 2);
});

test('reports a later page failure instead of presenting an incomplete account list', async () => {
	await assert.rejects(loadRobotAccounts(async query => {
		if (query.page_index === 2) throw new Error('session expired');
		return { items: Array.from({ length: 50 }, (_, id) => ({ id })), total: 51 };
	}), /session expired/);
});
