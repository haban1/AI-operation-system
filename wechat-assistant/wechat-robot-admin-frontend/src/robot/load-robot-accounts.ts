interface RobotPage<T> {
	items?: T[];
	total?: number;
}

/** The robot backend accepts at most 50 accounts in each page. */
export const loadRobotAccounts = async <T>(fetchPage: (query: { page_index: number; page_size: number }) => Promise<RobotPage<T>>) => {
	const pageSize = 50;
	const accounts: T[] = [];
	for (let pageIndex = 1; ; pageIndex += 1) {
		const page = await fetchPage({ page_index: pageIndex, page_size: pageSize });
		const items = page.items || [];
		accounts.push(...items);
		if (!items.length || pageIndex * pageSize >= (page.total ?? accounts.length)) return accounts;
	}
};
