import { expect } from 'chai';
import * as path from 'path';
import * as sinonImport from 'sinon';

import util from './util';

let sinon = sinonImport.createSandbox();
let cwd = process.cwd();
let rootConfigPath = path.join(process.cwd(), 'brsconfig.json');
let rootConfigDir = path.dirname(rootConfigPath);
let vfs = {};
//shorthand for normalizing a path
let n = path.normalize;

describe('util', () => {
    beforeEach(() => {
        vfs = {};
        sinon.stub(util, 'getFileContents').callsFake((filePath) => {
            if (vfs[filePath]) {
                return vfs[filePath];
            } else {
                throw new Error('Cannot find file ' + filePath);
            }
        });
    });

    afterEach(() => {
        sinon.restore();
        //restore current working directory
        process.chdir(cwd);
    });

    describe('loadConfigFile', () => {
        it('returns proper list of ancestor project paths', async () => {
            vfs[n(`${cwd}/child.json`)] = `{"extends": "parent.json"}`;
            vfs[n(`${cwd}/parent.json`)] = `{"extends": "grandparent.json"}`;
            vfs[n(`${cwd}/grandparent.json`)] = `{"extends": "greatgrandparent.json"}`;
            vfs[n(`${cwd}/greatgrandparent.json`)] = `{}`;
            let config = await util.loadConfigFile('child.json');
            expect(config._ancestors).to.eql([n(`${cwd}/child.json`), n(`${cwd}/parent.json`), n(`${cwd}/grandparent.json`), n(`${cwd}/greatgrandparent.json`)]);
        });

        it('returns empty ancestors list for non-extends files', async () => {
            vfs[n(`${cwd}/child.json`)] = `{}`;
            let config = await util.loadConfigFile('child.json');
            expect(config._ancestors).to.eql([n(`${cwd}/child.json`)]);
        });
    });

    describe('getConfigFilePath', async () => {
        it('returns undefined when it does not find the file', async () => {
            let configFilePath = await util.getConfigFilePath(path.join(process.cwd(), 'testProjects', 'project1'));
            expect(configFilePath).not.to.exist;
        });

        it('returns path to file when found', async () => {
            let rootDir = path.join(cwd, 'testProjects', 'project2');
            let configFilePath = await util.getConfigFilePath(rootDir);
            expect(configFilePath).to.equal(path.join(rootDir, 'brsconfig.json'));
        });

        it('finds config file in parent directory', async () => {
            let configFilePath = await util.getConfigFilePath(path.join(cwd, 'testProjects', 'project2', 'source'));
            expect(configFilePath).to.equal(path.join(cwd, 'testProjects', 'project2', 'brsconfig.json'));
        });

        it('uses cwd when not provided', async () => {
            //sanity check
            let configFilePath = await util.getConfigFilePath();
            expect(configFilePath).not.to.exist;

            let rootDir = path.join(cwd, 'testProjects', 'project2');
            process.chdir(rootDir);
            configFilePath = await util.getConfigFilePath();
            expect(configFilePath).to.equal(path.join(rootDir, 'brsconfig.json'));
        });
    });

    describe('normalizeConfig', () => {
        it('loads project from disc', async () => {
            vfs[rootConfigPath] = `{"outFile": "customOutDir/pkg.zip"}`;
            let config = await util.normalizeAndResolveConfig({ project: rootConfigPath });
            expect(config.outFile).to.equal(path.join(path.dirname(rootConfigPath), 'customOutDir', 'pkg.zip'));
        });

        it('loads project from disc and extends it', async () => {
            //the extends file
            let extendsConfigPath = path.join(rootConfigDir, 'testProjects', 'base_brsconfig.json');
            vfs[extendsConfigPath] = `{
                "outFile": "customOutDir/pkg1.zip",
                "rootDir": "core"
            }`;

            //the project file
            vfs[rootConfigPath] = `{
                "extends": "testProjects/base_brsconfig.json",
                "watch": true
            }`;

            let config = await util.normalizeAndResolveConfig({ project: rootConfigPath });

            expect(config.outFile).to.equal(path.join(rootConfigDir, 'testProjects', 'customOutDir', 'pkg1.zip'));
            expect(config.rootDir).to.equal(path.join(rootConfigDir, 'testProjects', 'core'));
            expect(config.watch).to.equal(true);
        });

        it('catches circular dependencies', async () => {
            vfs[rootConfigPath] = `{
                "extends": "brsconfig2.json"
            }`;
            vfs[path.join(rootConfigDir, 'brsconfig2.json')] = `{
                "extends": "brsconfig.json"
            }`;

            let threw = false;
            try {
                await util.normalizeAndResolveConfig({ project: rootConfigPath });
            } catch (e) {
                threw = true;
            }
            expect(threw).to.equal(true, 'Should have thrown an error');
            //the test passed
        });

        it('properly handles default for watch', async () => {
            let config = await util.normalizeAndResolveConfig({ watch: true });
            expect(config.watch).to.be.true;
        });
    });

    describe('stringFormat', () => {
        it('handles out-of-order replacements', () => {
            expect(util.stringFormat('{1}{0}', 'b', 'a')).to.equal('ab');
        });

        it('does not fail on arguments not provided', () => {
            expect(util.stringFormat('{0}{1}', 'a')).to.equal('a{1}');
        });

    });

    describe('getPkgPathFromTarget', () => {
        it('works with both types of separators', () => {
            expect(util.getPkgPathFromTarget('components/component1.xml', '../lib.brs')).to.equal('lib.brs');
            expect(util.getPkgPathFromTarget('components\\component1.xml', '../lib.brs')).to.equal('lib.brs');
        });

        it('resolves single dot directory', () => {
            expect(util.getPkgPathFromTarget('components/component1.xml', './lib.brs')).to.equal(n(`components/lib.brs`));
        });

        it('resolves absolute pkg paths as relative paths', () => {
            expect(util.getPkgPathFromTarget('components/component1.xml', 'pkg:/source/lib.brs')).to.equal(n(`source/lib.brs`));
            expect(util.getPkgPathFromTarget('components/component1.xml', 'pkg:/lib.brs')).to.equal(`lib.brs`);
        });

        it('resolves gracefully for invalid values', () => {
            expect(util.getPkgPathFromTarget('components/component1.xml', 'pkg:/')).to.equal(null);
            expect(util.getPkgPathFromTarget('components/component1.xml', 'pkg:')).to.equal(null);
            expect(util.getPkgPathFromTarget('components/component1.xml', 'pkg')).to.equal(n(`components/pkg`));
        });
    });

    describe('getRelativePath', () => {
        it('works when both files are at the root', () => {
            expect(util.getRelativePath('file.xml', 'file.brs')).to.equal('file.brs');
        });
        it('works when both files are in subfolder', () => {
            expect(util.getRelativePath('sub/file.xml', 'sub/file.brs')).to.equal('file.brs');
        });
        it('works when source in root, target in subdir', () => {
            expect(util.getRelativePath('file.xml', 'sub/file.brs')).to.equal(n(`sub/file.brs`));
        });
        it('works when source in sub, target in root', () => {
            expect(util.getRelativePath('sub/file.xml', 'file.brs')).to.equal(n(`../file.brs`));
        });
        it('works when source and target are in different subs', () => {
            expect(util.getRelativePath('sub1/file.xml', 'sub2/file.brs')).to.equal(n(`../sub2/file.brs`));
        });
    });

    describe('findAllDeep', () => {
        class Person {
            constructor(
                public name: string,
                public parent?: Person
            ) {
            }
        }
        it('finds all properties deep', () => {
            let grandpa = new Person('grandpa');
            let dad = new Person('dad', grandpa);
            let me = new Person('me', dad);
            let people = util.findAllDeep(me, (x) => x instanceof Person);
            expect(people[0]).to.eql({ key: undefined, value: me });
            expect(people[1]).to.eql({ key: 'parent', value: dad });
            expect(people[2]).to.eql({ key: 'parent.parent', value: grandpa });
        });

        it('finds properties in arrays', () => {
            let results = util.findAllDeep<{ id: number }>({
                children: [{
                    id: 1,
                    name: 'bob',
                    children: [{
                        id: 2,
                        name: 'john'
                    }, {
                        id: 3,
                        name: 'bob'
                    }]
                }, {
                    id: 4,
                    name: 'bob'
                }]
            }, (x) => { return x.name === 'bob'; });

            expect(results[0].key).to.eql('children.0');
            expect(results[0].value.id).to.eql(1);

            expect(results[1].key).to.eql('children.0.children.1');
            expect(results[1].value.id).to.eql(3);

            expect(results[2].key).to.eql('children.1');
            expect(results[2].value.id).to.eql(4);
        });
    });

    describe('padLeft', () => {
        it('stops at an upper limit to prevent terrible memory explosions', () => {
            expect(util.padLeft('', Number.MAX_VALUE, ' ')).to.be.lengthOf(1000);
        });
    });
});
