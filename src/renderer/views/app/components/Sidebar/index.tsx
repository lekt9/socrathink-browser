import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { SidebarContainer } from './style';
import { app } from '@electron/remote';

export const Sidebar = observer(() => {
    const webviewRef = React.useRef<Electron.WebviewTag>(null);

    React.useEffect(() => {
        const handleWebviewLoad = () => {
            if (webviewRef.current) {
                webviewRef.current.executeJavaScript(`
                    let viewport = document.querySelector('meta[name="viewport"]');
                    if (!viewport) {
                        viewport = document.createElement('meta');
                        viewport.name = 'viewport';
                        document.head.appendChild(viewport);
                    }
                    viewport.content = 'width=device-width, initial-scale=1, shrink-to-fit=no';
                `);
            }
        };

        if (webviewRef.current) {
            webviewRef.current.addEventListener('dom-ready', handleWebviewLoad);
        }

        return () => {
            if (webviewRef.current) {
                webviewRef.current.removeEventListener('dom-ready', handleWebviewLoad);
            }
        };
    }, []);

    return (
        <SidebarContainer>
            <webview
                ref={webviewRef}
                src="https://app.socrathink.com/"
                // src="http://localhost:3000"
                style={{ width: '100%', height: '100%' }}
                preload={`file://${app.getAppPath()}/build/sidebar-preload.bundle.js`}
                webpreferences="nativeWindowOpen=true"
            />
        </SidebarContainer>
    );
});