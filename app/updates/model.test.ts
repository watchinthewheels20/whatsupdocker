import { Container } from '../model/container';
import { targetFor, matchesTarget, stackId, messageOf } from './model';

const container = (values = {}) =>
    ({ id: 'old-id', name: 'web', watcher: 'local', ...values }) as Container;

describe('stable update targets', () => {
    test('uses watcher and name for standalone containers', () => {
        const target = targetFor(container());
        expect(matchesTarget(container({ id: 'replacement' }), target)).toBe(
            true,
        );
        expect(matchesTarget(container({ watcher: 'remote' }), target)).toBe(
            false,
        );
        expect(matchesTarget(container({ name: 'other' }), target)).toBe(false);
        expect(stackId(container())).toBeUndefined();
    });
    test('uses compose project and service across container replacements', () => {
        const labels = {
            'com.docker.compose.project': 'demo',
            'com.docker.compose.service': 'web',
        };
        const target = targetFor(container({ labels }));
        expect(
            matchesTarget(
                container({ id: 'new', name: 'demo-web-2', labels }),
                target,
            ),
        ).toBe(true);
        expect(
            matchesTarget(
                container({
                    labels: { ...labels, 'com.docker.compose.service': 'db' },
                }),
                target,
            ),
        ).toBe(false);
        expect(stackId(container({ labels }))).toBe('local:demo');
    });
    test.each([
        [new Error('failure'), 'failure'],
        ['failure', 'failure'],
        [null, 'null'],
    ])('normalizes errors %p', (error, message) => {
        expect(messageOf(error)).toBe(message);
    });
});
