#!/bin/bash
#
# detect-project.sh - Detects project type for deployment
#
# Output: Prints the project type (single line)
#
# Detected types:
#   - nextjs: Next.js application (package.json with 'next' dependency)
#   - vite: Vite-based project (vite.config.ts/js or vite in dependencies)
#   - cra: Create React App (react-scripts in dependencies)
#   - vue-cli: Vue CLI project (@vue/cli-service in dependencies)
#   - angular-cli: Angular CLI project (@angular/cli in dependencies)
#   - astro: Astro project (astro.config.mjs or astro in dependencies)
#   - nuxt: Nuxt project (nuxt.config.ts/js or nuxt in dependencies)
#   - gatsby: Gatsby project (gatsby in dependencies)
#   - remix: Remix project (remix.config.js or @remix-run/dev in dependencies)
#   - sveltekit: SvelteKit project (svelte.config.js with @sveltejs/kit)
#   - eleventy: Eleventy/11ty project (.eleventy.js or @11ty/eleventy in dependencies)
#   - generic: Has package.json with build script but no recognized framework
#   - plain-html: Plain HTML site (index.html in root)
#   - unknown: Could not detect project type
#
# Usage: ./detect-project.sh /path/to/project
#

PROJECT_DIR="${1:-/workspace/project}"

# Helper to check if a dependency exists in package.json
has_dependency() {
    local pkg_json="$1"
    local dep_name="$2"
    local result
    result=$(jq -r ".dependencies[\"$dep_name\"] // .devDependencies[\"$dep_name\"] // \"\"" "$pkg_json" 2>/dev/null)
    [ -n "$result" ] && [ "$result" != "null" ]
}

# Helper to check if a build script exists
has_build_script() {
    local pkg_json="$1"
    local result
    result=$(jq -r '.scripts.build // ""' "$pkg_json" 2>/dev/null)
    [ -n "$result" ] && [ "$result" != "null" ]
}

# Detect project type
detect_project_type() {
    local dir="$1"
    local pkg_json="$dir/package.json"
    
    # Check if package.json exists for framework detection
    if [ -f "$pkg_json" ]; then
        # Priority 1: Next.js (has next dependency)
        if has_dependency "$pkg_json" "next"; then
            echo "nextjs"
            return 0
        fi
        
        # Priority 2: Vite (vite.config.ts/js or vite dependency)
        if [ -f "$dir/vite.config.ts" ] || [ -f "$dir/vite.config.js" ] || [ -f "$dir/vite.config.mjs" ]; then
            echo "vite"
            return 0
        fi
        if has_dependency "$pkg_json" "vite"; then
            echo "vite"
            return 0
        fi
        
        # Priority 3: Create React App (react-scripts dependency)
        if has_dependency "$pkg_json" "react-scripts"; then
            echo "cra"
            return 0
        fi
        
        # Priority 4: Vue CLI (@vue/cli-service dependency)
        if has_dependency "$pkg_json" "@vue/cli-service"; then
            echo "vue-cli"
            return 0
        fi
        
        # Priority 5: Angular CLI (@angular/cli dependency and angular.json)
        if [ -f "$dir/angular.json" ] && has_dependency "$pkg_json" "@angular/cli"; then
            echo "angular-cli"
            return 0
        fi
        
        # Priority 6: Astro (astro.config.mjs or astro dependency)
        if [ -f "$dir/astro.config.mjs" ] || [ -f "$dir/astro.config.ts" ] || [ -f "$dir/astro.config.js" ]; then
            echo "astro"
            return 0
        fi
        if has_dependency "$pkg_json" "astro"; then
            echo "astro"
            return 0
        fi
        
        # Priority 7: Nuxt (nuxt.config.ts/js or nuxt dependency)
        if [ -f "$dir/nuxt.config.ts" ] || [ -f "$dir/nuxt.config.js" ]; then
            echo "nuxt"
            return 0
        fi
        if has_dependency "$pkg_json" "nuxt"; then
            echo "nuxt"
            return 0
        fi
        
        # Priority 8: Gatsby (gatsby dependency)
        if has_dependency "$pkg_json" "gatsby"; then
            echo "gatsby"
            return 0
        fi
        
        # Priority 9: Remix (remix.config.js or @remix-run/dev dependency)
        if [ -f "$dir/remix.config.js" ] || [ -f "$dir/remix.config.ts" ]; then
            echo "remix"
            return 0
        fi
        if has_dependency "$pkg_json" "@remix-run/dev"; then
            echo "remix"
            return 0
        fi
        
        # Priority 10: SvelteKit (svelte.config.js with @sveltejs/kit)
        if [ -f "$dir/svelte.config.js" ] && has_dependency "$pkg_json" "@sveltejs/kit"; then
            echo "sveltekit"
            return 0
        fi
        
        # Priority 11: Eleventy (.eleventy.js or @11ty/eleventy dependency)
        if [ -f "$dir/.eleventy.js" ] || [ -f "$dir/eleventy.config.js" ] || [ -f "$dir/eleventy.config.mjs" ] || [ -f "$dir/eleventy.config.cjs" ]; then
            echo "eleventy"
            return 0
        fi
        if has_dependency "$pkg_json" "@11ty/eleventy"; then
            echo "eleventy"
            return 0
        fi
        
        # Priority 12: Hugo (may have package.json for npm themes with PostCSS/Tailwind)
        # Check for Hugo config files
        for config in hugo.toml hugo.yaml hugo.json config.toml config.yaml config.json; do
            if [ -f "$dir/$config" ]; then
                # Verify it's a Hugo project by checking for typical directories
                if [ -d "$dir/content" ] || [ -d "$dir/layouts" ] || [ -d "$dir/themes" ] || [ -d "$dir/archetypes" ]; then
                    echo "hugo"
                    return 0
                fi
            fi
        done
        
        # Priority 13: Jekyll (may have package.json for Node.js assets)
        if [ -f "$dir/_config.yml" ] || [ -f "$dir/_config.yaml" ]; then
            # Check for Gemfile with jekyll
            if [ -f "$dir/Gemfile" ] && grep -qi "jekyll" "$dir/Gemfile"; then
                echo "jekyll"
                return 0
            fi
            # Check for typical Jekyll directories
            if [ -d "$dir/_posts" ] || [ -d "$dir/_layouts" ] || [ -d "$dir/_includes" ]; then
                echo "jekyll"
                return 0
            fi
        fi
        
        # Priority 14: Generic build (has build script but no recognized framework)
        if has_build_script "$pkg_json"; then
            echo "generic"
            return 0
        fi
    fi
    
    # Priority 15: Hugo (without package.json)
    for config in hugo.toml hugo.yaml hugo.json config.toml config.yaml config.json; do
        if [ -f "$dir/$config" ]; then
            # Verify it's a Hugo project by checking for typical directories
            if [ -d "$dir/content" ] || [ -d "$dir/layouts" ] || [ -d "$dir/themes" ] || [ -d "$dir/archetypes" ]; then
                echo "hugo"
                return 0
            fi
        fi
    done
    
    # Priority 16: Jekyll (without package.json)
    if [ -f "$dir/_config.yml" ] || [ -f "$dir/_config.yaml" ]; then
        # Check for Gemfile with jekyll
        if [ -f "$dir/Gemfile" ] && grep -qi "jekyll" "$dir/Gemfile"; then
            echo "jekyll"
            return 0
        fi
        # Check for typical Jekyll directories
        if [ -d "$dir/_posts" ] || [ -d "$dir/_layouts" ] || [ -d "$dir/_includes" ]; then
            echo "jekyll"
            return 0
        fi
    fi
        
    # Priority 17: Check for plain HTML site (index.html in root)
    if [ -f "$dir/index.html" ]; then
        echo "plain-html"
        return 0
    fi
    
    # Unknown project type
    echo "unknown"
    return 1
}

# Run detection
detect_project_type "$PROJECT_DIR"