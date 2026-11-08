#!/usr/bin/env python3
"""生成最小 iOS App 工程（单 target，用「同步文件夹」自动收录 <name>/ 下全部文件）。
用法：python3 mkproj.py <输出目录> <工程名> <Bundle ID> [KEY=VALUE ...额外构建设置]"""
import os, sys

def build(out, name, bundle, extra):
    proj = {'SDKROOT': 'iphoneos', 'IPHONEOS_DEPLOYMENT_TARGET': '18.0', 'SWIFT_VERSION': '5.0',
            'ALWAYS_SEARCH_USER_PATHS': 'NO', 'CODE_SIGN_STYLE': 'Manual', 'CODE_SIGN_IDENTITY': '"-"', 'DEVELOPMENT_TEAM': '""',
            'ENABLE_PREVIEWS': 'YES', 'ONLY_ACTIVE_ARCH': 'YES', 'SWIFT_OPTIMIZATION_LEVEL': '"-Onone"'}
    tgt = {'PRODUCT_BUNDLE_IDENTIFIER': bundle, 'PRODUCT_NAME': '"$(TARGET_NAME)"', 'GENERATE_INFOPLIST_FILE': 'YES',
           'INFOPLIST_KEY_UILaunchScreen_Generation': 'YES', 'INFOPLIST_KEY_UIApplicationSceneManifest_Generation': 'YES',
           'INFOPLIST_KEY_UISupportedInterfaceOrientations': 'UIInterfaceOrientationPortrait', 'TARGETED_DEVICE_FAMILY': '1',
           'CURRENT_PROJECT_VERSION': '1', 'MARKETING_VERSION': '1.0', 'ASSETCATALOG_COMPILER_APPICON_NAME': '""'}
    tgt.update(extra)
    def cfg(i, n, s):
        body = ''.join(f'\t\t\t\t{k} = {v};\n' for k, v in s.items())
        return f'\t\t{i} /* {n} */ = {{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {{\n{body}\t\t\t}};\n\t\t\tname = {n};\n\t\t}};\n'
    txt = f'''// !$*UTF8*$!
{{
	archiveVersion = 1;
	classes = {{
	}};
	objectVersion = 77;
	objects = {{

/* Begin PBXFileReference section */
		C20000000000000000000003 /* {name}.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = {name}.app; sourceTree = BUILT_PRODUCTS_DIR; }};
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
		C10000000000000000000001 /* {name} */ = {{
			isa = PBXFileSystemSynchronizedRootGroup;
			path = {name};
			sourceTree = "<group>";
		}};
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
		C60000000000000000000001 /* Frameworks */ = {{
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		C70000000000000000000001 = {{
			isa = PBXGroup;
			children = (
				C10000000000000000000001 /* {name} */,
				C70000000000000000000004 /* Products */,
			);
			sourceTree = "<group>";
		}};
		C70000000000000000000004 /* Products */ = {{
			isa = PBXGroup;
			children = (
				C20000000000000000000003 /* {name}.app */,
			);
			name = Products;
			sourceTree = "<group>";
		}};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		C50000000000000000000001 /* {name} */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = C80000000000000000000002 /* Build configuration list for PBXNativeTarget "{name}" */;
			buildPhases = (
				C90000000000000000000001 /* Sources */,
				C60000000000000000000001 /* Frameworks */,
				C90000000000000000000003 /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
				C10000000000000000000001 /* {name} */,
			);
			name = {name};
			productName = {name};
			productReference = C20000000000000000000003 /* {name}.app */;
			productType = "com.apple.product-type.application";
		}};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		C40000000000000000000001 /* Project object */ = {{
			isa = PBXProject;
			attributes = {{
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 2600;
				LastUpgradeCheck = 2600;
				TargetAttributes = {{
					C50000000000000000000001 = {{
						CreatedOnToolsVersion = 26.0;
					}};
				}};
			}};
			buildConfigurationList = C80000000000000000000001 /* Build configuration list for PBXProject "{name}" */;
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = C70000000000000000000001;
			minimizedProjectReferenceProxies = 1;
			preferredProjectObjectVersion = 77;
			productRefGroup = C70000000000000000000004 /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				C50000000000000000000001 /* {name} */,
			);
		}};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		C90000000000000000000003 /* Resources */ = {{
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		C90000000000000000000001 /* Sources */ = {{
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
{cfg('CA0000000000000000000001', 'Debug', proj)}{cfg('CA0000000000000000000002', 'Release', proj)}{cfg('CA0000000000000000000003', 'Debug', tgt)}{cfg('CA0000000000000000000004', 'Release', tgt)}/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		C80000000000000000000001 /* Build configuration list for PBXProject "{name}" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				CA0000000000000000000001 /* Debug */,
				CA0000000000000000000002 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Debug;
		}};
		C80000000000000000000002 /* Build configuration list for PBXNativeTarget "{name}" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				CA0000000000000000000003 /* Debug */,
				CA0000000000000000000004 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Debug;
		}};
/* End XCConfigurationList section */
	}};
	rootObject = C40000000000000000000001 /* Project object */;
}}
'''
    os.makedirs(f'{out}/{name}.xcodeproj', exist_ok=True)
    os.makedirs(f'{out}/{name}', exist_ok=True)
    open(f'{out}/{name}.xcodeproj/project.pbxproj', 'w').write(txt)

if __name__ == '__main__':
    out, name, bundle = sys.argv[1:4]
    extra = dict(a.split('=', 1) for a in sys.argv[4:])
    build(out, name, bundle, extra)
    print(f'{out}/{name}.xcodeproj')
