export interface AboutPanelProps {
    repositoryUrl: string;
    version: string;
    license: string;
    compatibleVersions: string;
    onCheckUpdate?: () => void;
}
export declare function AboutPanel({ repositoryUrl, version, license, compatibleVersions, onCheckUpdate }: AboutPanelProps): import("react").JSX.Element;
