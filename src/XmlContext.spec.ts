import { assert, expect } from 'chai';
import * as path from 'path';

import { XmlFile } from './files/XmlFile';
import { Program } from './Program';
import { XmlContext } from './XmlContext';

let n = path.normalize;
let rootDir = 'C:/projects/RokuApp';

describe('XmlContext', () => {
    let xmlFile: XmlFile;
    let context: XmlContext;
    let program: Program;
    let xmlFilePath = n(`${rootDir}/components/component.xml`);
    beforeEach(() => {

        program = new Program({ rootDir: rootDir });
        xmlFile = new XmlFile(xmlFilePath, n('components/component.xml'), program);
        context = new XmlContext(xmlFile);
        context.attachProgram(program);

        context.parentContext = program.platformContext;
    });
    describe('onProgramFileRemove', () => {
        it('handles file-removed event when file does not have component name', async () => {
            xmlFile.parentComponentName = 'Scene';
            xmlFile.componentName = 'ParentComponent';
            let namelessComponent = await program.addOrReplaceFile(`${rootDir}/components/child.xml`, `
                <?xml version="1.0" encoding="utf-8" ?>
                <component extends="ParentComponent">
                </component>
            `);
            try {
                (context as any).onProgramFileRemove(namelessComponent);
            } catch (e) {
                assert.fail(null, null, 'Should not have thrown');
            }
        });
    });

    describe('constructor', () => {
        it('listens for attach/detach parent events', () => {
            let parentXmlFile = new XmlFile(n(`${rootDir}/components/parent.xml`), n('components/parent.xml'), program);
            let parentContext = new XmlContext(parentXmlFile);
            program.contexts[parentContext.name] = parentContext;

            //should default to platform context
            expect(context.parentContext).to.equal(program.platformContext);

            //when the xml file attaches an xml parent, the xml context should be notified and find its parent context
            xmlFile.attachParent(parentXmlFile);
            expect(context.parentContext).to.equal(parentContext);

            xmlFile.detachParent();
            expect(context.parentContext).to.equal(program.platformContext);
        });
    });
});
