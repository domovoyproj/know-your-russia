#!/usr/bin/env bash
set -e

SDK_DIR="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
BUILD_TOOLS="$SDK_DIR/build-tools/34.0.0"
PLATFORM="$SDK_DIR/platforms/android-34/android.jar"
WORK_DIR="/tmp/kyr-apk-build"

echo "==> Building KYR Android APK..."
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/gen" "$WORK_DIR/bin/dex" "$WORK_DIR/res_compiled"

cd /opt/kyr/android

echo "==> 1. Compiling resources with aapt2..."
"$BUILD_TOOLS/aapt2" compile --dir app/src/main/res -o "$WORK_DIR/compiled_res.zip"

echo "==> 2. Linking resources and generating R.java..."
"$BUILD_TOOLS/aapt2" link -I "$PLATFORM" \
    --manifest app/src/main/AndroidManifest.xml \
    --java "$WORK_DIR/gen" \
    -o "$WORK_DIR/base.apk" \
    "$WORK_DIR/compiled_res.zip"

echo "==> 3. Compiling Java sources with javac..."
javac -cp "$PLATFORM" \
    -d "$WORK_DIR/bin" \
    "$WORK_DIR/gen/ru/kyr/app/R.java" \
    app/src/main/java/ru/kyr/app/MainActivity.java

echo "==> 4. Converting bytecode to Dalvik dex with d8..."
"$BUILD_TOOLS/d8" --min-api 26 \
    --lib "$PLATFORM" \
    --output "$WORK_DIR/bin/dex" \
    "$WORK_DIR/bin/ru/kyr/app/"*.class

echo "==> 5. Adding classes.dex to APK package..."
(cd "$WORK_DIR/bin/dex" && jar uf "$WORK_DIR/base.apk" classes.dex)

echo "==> 6. Aligning APK with zipalign..."
"$BUILD_TOOLS/zipalign" -f -p 4 "$WORK_DIR/base.apk" "$WORK_DIR/aligned.apk"

echo "==> 7. Signing APK with apksigner..."
KEYSTORE="/opt/kyr-build/kyr-release.keystore"
if [ ! -f "$KEYSTORE" ]; then
    mkdir -p /opt/kyr-build
    keytool -genkey -v -keystore "$KEYSTORE" \
        -alias kyr \
        -storepass kyrpassword \
        -keypass kyrpassword \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=KYR, OU=KnowYourRussia, O=KYR, L=Moscow, ST=Moscow, C=RU"
fi

mkdir -p /opt/kyr/public/download
"$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" \
    --ks-pass pass:kyrpassword \
    --key-pass pass:kyrpassword \
    --out /opt/kyr/public/download/kyr.apk \
    "$WORK_DIR/aligned.apk"

echo "==> 8. Verifying APK signature..."
"$BUILD_TOOLS/apksigner" verify /opt/kyr/public/download/kyr.apk

echo "==> Build successful! File size:"
ls -lh /opt/kyr/public/download/kyr.apk
